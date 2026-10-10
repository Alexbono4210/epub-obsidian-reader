const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const START = '<!-- EPUB_READER_START -->';
const END = '<!-- EPUB_READER_END -->';
const NOTES_START = '<!-- EPUB_READER_NOTES_START -->';
const NOTES_END = '<!-- EPUB_READER_NOTES_END -->';

function cleanName(value) {
  return String(value || '未命名').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/[. ]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 90) || '未命名';
}

function yamlString(value) {
  return JSON.stringify(safeManagedText(value));
}

function safeManagedText(value) {
  return String(value || '').replaceAll('<!-- EPUB_READER_', '&lt;!-- EPUB_READER_');
}

function chapterIndex(note) {
  if (Number.isInteger(note.chapterIndex) && note.chapterIndex >= 0) return note.chapterIndex;
  const match = String(note.cfi || '').match(/^epubcfi\(\/\d+(?:\[[^\]]*\])?\/(\d+)/);
  return match ? Number(match[1]) / 2 - 1 : Number.MAX_SAFE_INTEGER;
}

function notesMarkdown(book) {
  const notes = [...(book.notes || [])].sort((a, b) => chapterIndex(a) - chapterIndex(b) || a.createdAt.localeCompare(b.createdAt));
  const groups = new Map();
  for (const note of notes) {
    const chapter = String(note.chapter || '').trim() || '未命名章节';
    const key = `${chapterIndex(note)}:${chapter}`;
    if (!groups.has(key)) groups.set(key, { chapter, notes: [] });
    groups.get(key).notes.push(note);
  }
  const lines = ['## 摘录与笔记', ''];
  if (!notes.length) lines.push('暂无笔记。', '');
  for (const group of groups.values()) {
    lines.push(`### ${safeManagedText(group.chapter)}`, '');
    group.notes.forEach((note, index) => {
      if (index) lines.push('---', '');
      if (note.quote) {
        for (const line of safeManagedText(note.quote).split(/\r?\n/)) lines.push(`> ${line}`);
        lines.push('');
      }
      if (note.text) lines.push(safeManagedText(note.text).trim(), '');
    });
  }
  return lines.join('\n').trimEnd() + '\n';
}

function markdownHeader(book) {
  const lines = [
    '---',
    `title: ${yamlString(book.title)}`,
    `author: ${yamlString(book.author)}`,
    'tags:',
    '  - epub-reading',
    `epub_reader_id: ${yamlString(book.id)}`,
    '---',
    '',
    `# ${safeManagedText(book.title || '未命名')}`,
    '',
    book.author ? `作者：${safeManagedText(book.author)}` : '',
    book.progress ? `阅读进度：${Math.round(book.progress * 100)}%` : '',
    ''
  ].filter((line, index, all) => !(line === '' && all[index - 1] === ''));

  return lines.join('\n').trimEnd() + '\n\n';
}

function markdown(book) {
  return markdownHeader(book) + notesMarkdown(book);
}

function replaceManaged(existing, generated, startMarker = START, endMarker = END) {
  const managed = `${startMarker}\n${generated}${endMarker}`;
  if (!existing) return managed + '\n';
  const start = existing.indexOf(startMarker);
  const end = existing.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) return null;
  return existing.slice(0, start) + managed + existing.slice(end + endMarker.length);
}

async function atomicWrite(file, content) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temp, content, 'utf8');
  try { await fs.rename(temp, file); }
  catch (error) { await fs.rm(temp, { force: true }); throw error; }
}

class ReaderStore {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'library.json');
    this.data = { vaultPath: '', books: [] };
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.join(this.root, 'books'), { recursive: true });
    try { this.data = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.data.books ||= [];
  }

  enqueue(work) {
    const run = this.queue.then(work);
    this.queue = run.catch(() => {});
    return run;
  }

  async persist() { await atomicWrite(this.file, JSON.stringify(this.data, null, 2)); }

  publicState() {
    return { vaultPath: this.data.vaultPath, books: this.data.books.map(({ file, ...book }) => book) };
  }

  book(id) {
    const book = this.data.books.find((entry) => entry.id === id);
    if (!book) throw new Error('找不到这本书');
    return book;
  }

  async importFile(source) {
    const bytes = await fs.readFile(source);
    if (path.extname(source).toLowerCase() !== '.epub' || bytes.subarray(0, 2).toString() !== 'PK') throw new Error('请选择有效的 EPUB 文件');
    const id = crypto.createHash('sha256').update(bytes).digest('hex');
    const existing = this.data.books.find((book) => book.id === id);
    if (existing) return existing.id;
    const destination = path.join(this.root, 'books', `${id}.epub`);
    await fs.writeFile(destination, bytes);
    this.data.books.unshift({ id, file: destination, title: path.basename(source, path.extname(source)), author: '', progress: 0, cfi: '', notes: [], addedAt: new Date().toISOString(), exportFile: '' });
    await this.persist();
    return id;
  }

  async updateBook(id, changes) {
    const book = this.book(id);
    if (typeof changes.title === 'string') book.title = changes.title.slice(0, 300);
    if (typeof changes.author === 'string') book.author = changes.author.slice(0, 300);
    if (typeof changes.cfi === 'string') book.cfi = changes.cfi.slice(0, 3000);
    if (Number.isFinite(changes.progress)) book.progress = Math.max(0, Math.min(1, changes.progress));
    await this.persist();
    return this.publicState();
  }

  async saveNote(id, note) {
    const book = this.book(id);
    if (!note || (typeof note.quote !== 'string' && typeof note.text !== 'string')) throw new Error('笔记内容不能为空');
    const now = new Date().toISOString();
    const existing = note.id && book.notes.find((entry) => entry.id === note.id);
    const saved = {
      id: existing?.id || crypto.randomUUID(),
      quote: String(note.quote || '').slice(0, 10000),
      text: String(note.text || '').slice(0, 20000),
      cfi: String(note.cfi || '').slice(0, 3000),
      chapter: String(note.chapter || '').slice(0, 300),
      chapterIndex: Number.isInteger(note.chapterIndex) && note.chapterIndex >= 0 ? note.chapterIndex : existing?.chapterIndex,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    if (!saved.quote.trim() && !saved.text.trim()) throw new Error('笔记内容不能为空');
    if (existing) Object.assign(existing, saved);
    else book.notes.push(saved);
    await this.persist();
    const sync = await this.syncSafely(book);
    return { state: this.publicState(), sync };
  }

  async deleteNote(id, noteId) {
    const book = this.book(id);
    book.notes = book.notes.filter((note) => note.id !== noteId);
    await this.persist();
    const sync = await this.syncSafely(book);
    return { state: this.publicState(), sync };
  }

  async setVault(folder) {
    this.data.vaultPath = folder;
    await this.persist();
    return this.syncAll();
  }

  async syncAll() {
    const results = [];
    for (const book of this.data.books) results.push(await this.syncSafely(book));
    return { state: this.publicState(), results };
  }

  async syncSafely(book) {
    try { return await this.syncBook(book); }
    catch (error) { return { status: 'error', message: error.message }; }
  }

  async syncBook(book) {
    if (!this.data.vaultPath) return { status: 'not-configured' };
    if (!book.notes.length && !book.exportFile) return { status: 'no-notes' };
    const folder = path.join(this.data.vaultPath, 'EPUB 阅读笔记');
    await fs.mkdir(folder, { recursive: true });
    if (!book.exportFile) {
      book.exportFile = `${cleanName(book.title)} - ${book.id.slice(0, 8)}.md`;
      await this.persist();
    }
    const target = path.join(folder, book.exportFile);
    let existing = '';
    try { existing = await fs.readFile(target, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const content = !existing
      ? markdownHeader(book) + replaceManaged('', notesMarkdown(book), NOTES_START, NOTES_END)
      : existing.includes(NOTES_START)
        ? replaceManaged(existing, notesMarkdown(book), NOTES_START, NOTES_END)
        : replaceManaged(existing, markdown(book));
    if (content === null) throw new Error(`目标文件已存在且不是本阅读器创建的笔记：${target}`);
    await atomicWrite(target, content);
    return { status: 'synced', path: target };
  }
}

module.exports = { ReaderStore, cleanName, markdown, notesMarkdown, replaceManaged, NOTES_START, NOTES_END };
