const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ReaderStore, replaceManaged, markdown } = require('../electron/store.cjs');

test('saving a note writes Markdown and preserves text outside the managed section', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epub-reader-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ReaderStore(path.join(root, 'data'));
  await store.init();
  const id = 'a'.repeat(64);
  store.data.books.push({ id, file: '', title: '测试书', author: '作者', progress: .42, cfi: '', notes: [], addedAt: '', exportFile: '' });
  await store.persist();
  const vault = path.join(root, 'vault');
  await fs.mkdir(vault);
  await store.setVault(vault);
  const saved = await store.saveNote(id, { quote: '一句值得记录的话', text: '我的想法', cfi: 'epubcfi(/6/2)', chapter: '第一章' });
  assert.equal(saved.sync.status, 'synced');
  const file = saved.sync.path;
  let content = await fs.readFile(file, 'utf8');
  assert.match(content, /一句值得记录的话/);
  assert.match(content, /我的想法/);
  assert.match(content, /阅读进度：42%/);
  await fs.writeFile(file, `${content.replace('  - epub-reading', '  - 我的阅读标签')}\n## 我的补充\n保留这段文字\n`);
  await store.saveNote(id, { quote: '第二句', text: '', cfi: '', chapter: '第二章' });
  content = await fs.readFile(file, 'utf8');
  assert.match(content, /保留这段文字/);
  assert.match(content, /第二句/);
  assert.match(content, /我的阅读标签/);
  assert.equal((content.match(/EPUB_READER_NOTES_START/g) || []).length, 1);
});

test('unmanaged existing files are never overwritten', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epub-reader-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ReaderStore(path.join(root, 'data'));
  await store.init();
  const id = 'b'.repeat(64);
  store.data.books.push({ id, file: '', title: '同名书', author: '', progress: 0, cfi: '', notes: [], addedAt: '', exportFile: '' });
  await store.persist();
  const vault = path.join(root, 'vault');
  const folder = path.join(vault, 'EPUB 阅读笔记');
  await fs.mkdir(folder, { recursive: true });
  const target = path.join(folder, `同名书 - ${id.slice(0, 8)}.md`);
  await fs.writeFile(target, '这是原有笔记');
  await store.setVault(vault);
  const result = await store.saveNote(id, { quote: '摘录', text: '', cfi: '', chapter: '' });
  assert.equal(result.sync.status, 'error');
  assert.equal(await fs.readFile(target, 'utf8'), '这是原有笔记');
  assert.equal(store.book(id).notes.length, 1);
});

test('managed section replacement leaves surrounding content intact', () => {
  assert.equal(replaceManaged('前文\n<!-- EPUB_READER_START -->\n旧文\n<!-- EPUB_READER_END -->\n后文', '新文\n'), '前文\n<!-- EPUB_READER_START -->\n新文\n<!-- EPUB_READER_END -->\n后文');
});

test('notes are grouped in book chapter order without visible timestamps or CFIs', () => {
  const notes = [
    { chapter: '第二章', quote: '第二章原文', text: '第二章想法', cfi: 'epubcfi(/6/12!/4/2:0)', createdAt: '2026-10-10T01:00:00Z' },
    { chapter: '简介', quote: '简介原文一', text: '想法一', cfi: 'epubcfi(/6/10!/4/2:0)', createdAt: '2026-10-10T02:00:00Z' },
    { chapter: '简介', quote: '简介原文二', text: '想法二', cfi: 'epubcfi(/6/10!/4/4:0)', createdAt: '2026-10-10T03:00:00Z' }
  ];
  const text = markdown({ title: '测试书', id: 'test', notes });
  assert.equal((text.match(/^### 简介$/gm) || []).length, 1);
  assert.ok(text.indexOf('### 简介') < text.indexOf('### 第二章'));
  assert.ok(text.indexOf('想法一') < text.indexOf('简介原文二'));
  assert.match(text, /想法一\n\n---\n\n> 简介原文二/);
  assert.doesNotMatch(text, /记录时间|位置：|epubcfi\(|2026-10-10T/);
  assert.equal(notes[0].cfi, 'epubcfi(/6/12!/4/2:0)');
});

test('chapters with the same name in different book sections stay separate', () => {
  const text = markdown({ title: '测试书', id: 'test', notes: [
    { chapter: '小结', quote: '第一部分', cfi: 'epubcfi(/6/10!/4/2:0)', createdAt: '2026-10-10T01:00:00Z' },
    { chapter: '小结', quote: '第二部分', cfi: 'epubcfi(/6/12!/4/2:0)', createdAt: '2026-10-10T02:00:00Z' }
  ] });
  assert.equal((text.match(/^### 小结$/gm) || []).length, 2);
});
