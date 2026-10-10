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
  assert.equal(result.sync.bookId, id);
  assert.deepEqual(result.state.books[0].lastSync, result.sync);
  assert.equal(await fs.readFile(target, 'utf8'), '这是原有笔记');
  assert.equal(store.book(id).notes.length, 1);
  const restarted = new ReaderStore(path.join(root, 'data'));
  await restarted.init();
  assert.equal(restarted.book(id).notes.length, 1);
  assert.equal(restarted.book(id).lastSync.status, 'error');
  await fs.writeFile(target, '<!-- EPUB_READER_NOTES_START -->\n<!-- EPUB_READER_NOTES_END -->\n');
  const retried = await restarted.syncAll();
  assert.equal(retried.results[0].status, 'synced');
  assert.equal(retried.results[0].bookId, id);
  assert.equal(retried.state.books[0].lastSync.path, target);
  assert.match(await fs.readFile(target, 'utf8'), /摘录/);
  const afterRetry = new ReaderStore(path.join(root, 'data'));
  await afterRetry.init();
  assert.deepEqual(afterRetry.book(id).lastSync, retried.results[0]);
});

test('V0.2 reports and persists its separate export directory without changing a same-name V0.1 file', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epub-reader-v02-sync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const exportFolder = path.join('EPUB 阅读笔记', 'V0.2');
  const store = new ReaderStore(path.join(root, 'data'), exportFolder);
  await store.init();
  assert.equal(store.publicState().exportDirectory, '');
  assert.equal(store.publicState().exportFolder, exportFolder);
  const id = 'c'.repeat(64);
  store.data.books.push({ id, file: '', title: '同一本书', notes: [], exportFile: '同一本书.md' });
  const vault = path.join(root, 'vault');
  const legacyFile = path.join(vault, 'EPUB 阅读笔记', '同一本书.md');
  await fs.mkdir(path.dirname(legacyFile), { recursive: true });
  const legacyContent = '# 原版文件\n原版记录';
  await fs.writeFile(legacyFile, legacyContent);
  await store.setVault(vault);
  const saved = await store.saveNote(id, { text: '只属于 V0.2 的新笔记', chapter: '第一章' });
  const target = path.join(vault, exportFolder, '同一本书.md');
  assert.equal(saved.sync.status, 'synced');
  assert.equal(saved.sync.path, target);
  assert.equal(saved.sync.bookId, id);
  assert.ok(Number.isFinite(Date.parse(saved.sync.at)));
  assert.equal(saved.state.exportDirectory, path.dirname(target));
  assert.deepEqual(saved.state.books[0].lastSync, saved.sync);
  assert.equal(await fs.readFile(legacyFile, 'utf8'), legacyContent);
  assert.match(await fs.readFile(target, 'utf8'), /只属于 V0.2 的新笔记/);
  const restarted = new ReaderStore(path.join(root, 'data'), exportFolder);
  await restarted.init();
  assert.deepEqual(restarted.book(id).lastSync, saved.sync);
  await restarted.setVault('');
  assert.equal(restarted.publicState().exportDirectory, '');
  assert.equal(restarted.book(id).lastSync.status, 'not-configured');
  assert.equal(restarted.book(id).lastSync.path, undefined);
  const disconnected = new ReaderStore(path.join(root, 'data'), exportFolder);
  await disconnected.init();
  assert.equal(disconnected.book(id).lastSync.status, 'not-configured');
});

test('a status persistence failure does not misreport a successful Markdown export', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epub-reader-sync-status-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ReaderStore(path.join(root, 'data'));
  await store.init();
  const id = 'd'.repeat(64);
  store.data.books.push({ id, file: '', title: '测试书', notes: [], exportFile: '测试书.md' });
  await store.setVault(path.join(root, 'vault'));
  const persist = store.persist.bind(store);
  let writes = 0;
  store.persist = async () => {
    if (++writes === 2) throw new Error('模拟状态文件暂时不可写');
    return persist();
  };
  const saved = await store.saveNote(id, { text: '已在本地保存，也已导出' });
  assert.equal(saved.sync.status, 'synced');
  assert.match(saved.sync.warning, /同步状态未能保存/);
  assert.match(await fs.readFile(saved.sync.path, 'utf8'), /已在本地保存，也已导出/);
  const restarted = new ReaderStore(path.join(root, 'data'));
  await restarted.init();
  assert.equal(restarted.book(id).notes.length, 1);
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
