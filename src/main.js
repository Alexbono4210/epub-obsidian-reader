import ePub from 'epubjs';
import { flattenToc, chapterAt } from './chapters.mjs';
import { mountReview } from './review.js';
import './style.css';

const api = window.readerAPI;
const app = document.getElementById('app');
let state = { vaultPath: '', books: [] };
let currentId = null;
let epub = null;
let rendition = null;
let toc = [];
let selected = null;
let activeNoteId = null;
let fontSize = Number(localStorage.getItem('readerFontSize')) || 100;
let theme = localStorage.getItem('readerTheme') || 'paper';
let savePositionTimer;
let opening = false;
let view = 'shelf';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const currentBook = () => state.books.find((book) => book.id === currentId);
const short = (value, max = 65) => value.length > max ? value.slice(0, max) + '…' : value;
const percent = (value) => `${Math.round((value || 0) * 100)}%`;

function toast(message, error = false) {
  document.querySelectorAll('.toast').forEach(node => node.remove());
  const node = document.createElement('div');
  node.className = `toast ${error ? 'error' : ''}`;
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 4200);
}

function render() {
  app.dataset.theme = theme;
  app.innerHTML = `
    <aside class="sidebar">
      <button class="brand brand-home" id="home" title="返回书架"><span class="brand-mark">页</span><div><strong>页间</strong><small>V0.2 · READING SPACE</small></div></button>
      <button class="import-btn" id="import"><span>＋</span> 导入 EPUB</button>
      <div class="sidebar-label">我的书架 <span>${state.books.length}</span></div>
      <div class="book-list">${state.books.length ? state.books.map((book) => `
        <button class="book-item ${book.id === currentId ? 'active' : ''}" data-book="${book.id}">
          <span class="mini-cover">${escapeHtml((book.title || '书').slice(0, 1))}</span>
          <span class="book-meta"><strong>${escapeHtml(short(book.title || '未命名'))}</strong><small>${escapeHtml(book.author || '未知作者')}</small><span class="mini-progress"><i style="width:${percent(book.progress)}"></i></span></span>
        </button>`).join('') : '<div class="shelf-empty">导入一本 EPUB，开始阅读。</div>'}</div>
      <div class="sidebar-bottom">
        <div class="sync-label"><span class="sync-dot ${state.vaultPath ? 'connected' : ''}"></span>${state.vaultPath ? '已连接 Obsidian' : '尚未连接 Obsidian'}</div>
        <button id="choose-vault" class="vault-btn" title="${escapeHtml(state.vaultPath)}">${state.vaultPath ? '更换仓库文件夹' : '选择仓库文件夹'} <span>↗</span></button>
      </div>
    </aside>
    <main class="main">
      ${view === 'review' ? '<div id="review-root"></div>' : currentId ? readerHtml() : welcomeHtml()}
    </main>`;
  bindShell();
  if (view === 'review') mountReview(document.getElementById('review-root'), api, state, currentId, { home: goHome, read: openBook, toast });
  else if (currentId) bindReader();
}

function welcomeHtml() {
  return `<div class="welcome"><div class="welcome-ornament">✳</div><p class="eyebrow">YOUR READING SPACE</p><h1>一点启发，<br>也值得付诸行动。</h1><p class="welcome-description">阅读时，留下自己的摘录与想法。<br>结束阅读后，挑一点启发讨论，再试一个小行动。</p><div class="welcome-actions"><button id="welcome-import" class="primary-btn">${state.books.length ? '导入新书' : '导入第一本书'} <span>→</span></button>${state.books.length ? '<button id="review-entry" class="secondary-btn">读后回顾 →</button>' : ''}</div><div class="welcome-steps"><span>01 <b>阅读与输出</b></span><span>02 <b>读后讨论</b></span><span>03 <b>行动与回看</b></span></div></div>`;
}

function readerHtml() {
  const book = currentBook();
  return `<header class="topbar">
    <div class="book-heading"><p>正在阅读 <span> / </span> ${escapeHtml(book.author || '未知作者')}</p><h2>${escapeHtml(book.title)}</h2></div>
    <div class="top-actions"><button class="icon-btn" id="font-down" title="缩小字体">A−</button><span class="font-value">${fontSize}%</span><button class="icon-btn" id="font-up" title="放大字体">A＋</button><span class="divider"></span><button class="icon-btn theme-toggle" id="theme" title="切换阅读主题">${theme === 'paper' ? '◐' : '☼'}</button><button class="secondary-btn finish-btn" id="finish-reading">结束本次阅读 →</button></div>
  </header>
  <div class="reader-body">
    <section class="reading-column"><div class="chapter-strip"><button id="toc-toggle" class="chapter-toggle">☷ <span id="chapter-label">目录</span></button><span id="page-status">${percent(book.progress)}</span></div><div class="reading-frame"><div id="epub-view"></div><div id="book-loading">正在打开电子书…</div></div><footer class="reading-footer"><button id="prev" aria-label="上一页">← <span>上一页</span></button><div class="progress-track"><i id="progress-bar" style="width:${percent(book.progress)}"></i></div><span id="progress-text">${percent(book.progress)}</span><button id="next" aria-label="下一页"><span>下一页</span> →</button></footer></section>
    <aside class="notes-panel"><div class="notes-head"><div><p class="eyebrow">READING NOTES</p><h3>摘录与笔记 <span id="notes-count">${book.notes.length}</span></h3></div><button id="sync-now" title="立即同步到 Obsidian">↻</button></div><div class="notes-subtitle">选中原文记笔记，或直接写下想法。<button id="quick-note" class="quick-note">＋ 随手记</button></div><div id="selection-panel" class="selection-panel hidden"></div><div id="notes-list" class="notes-list"></div><div class="notes-footer"><span class="sync-dot ${state.vaultPath ? 'connected' : ''}"></span><span>${state.vaultPath ? '笔记自动同步到 Obsidian' : '连接 Obsidian 后自动同步'}</span>${book.exportFile ? '<button id="open-export">打开笔记 ↗</button>' : ''}</div></aside>
  </div>
  <div id="toc-popover" class="toc-popover hidden"><div class="toc-head"><strong>目录</strong><button id="toc-close">×</button></div><div id="toc-list"></div></div>`;
}

function bindShell() {
  document.getElementById('home').onclick = goHome;
  document.getElementById('review-entry')?.addEventListener('click', () => showReview(null));
  document.getElementById('import').onclick = importBooks;
  document.getElementById('welcome-import')?.addEventListener('click', importBooks);
  document.getElementById('choose-vault').onclick = async () => {
    try {
      const result = await api.chooseVault();
      state = result.state;
      const id = currentId;
      if (id && view === 'reader') await openBook(id);
      else render();
      const failed = result.results.filter((entry) => entry.status === 'error');
      toast(failed.length ? `仓库已连接，但有 ${failed.length} 本书同步失败：${failed[0].message}` : state.vaultPath ? 'Obsidian 仓库已连接，现有笔记已同步' : '未选择仓库', failed.length > 0);
    } catch (error) { toast(error.message, true); }
  };
  document.querySelectorAll('[data-book]').forEach((node) => node.onclick = () => openBook(node.dataset.book));
}

async function importBooks() {
  try {
    const result = await api.importBooks();
    state = result.state;
    if (result.imported.length) {
      render();
      await openBook(result.imported[0]);
      toast(`已导入 ${result.imported.length} 本书`);
    }
  } catch (error) { toast(error.message, true); }
}

function bindReader() {
  document.getElementById('quick-note').onclick = () => {
    const cfi = rendition?.currentLocation()?.start?.cfi || '';
    selected = { quote: '', cfi, chapter: chapterForLocation(), chapterIndex: epub?.spine.get(cfi)?.index };
    activeNoteId = null; renderSelection(); document.getElementById('note-text').focus();
  };
  document.getElementById('finish-reading').onclick = () => showReview(currentId);
  document.getElementById('prev').onclick = () => rendition?.prev();
  document.getElementById('next').onclick = () => rendition?.next();
  document.getElementById('font-down').onclick = () => adjustFont(-10);
  document.getElementById('font-up').onclick = () => adjustFont(10);
  document.getElementById('theme').onclick = () => { theme = theme === 'paper' ? 'night' : 'paper'; localStorage.setItem('readerTheme', theme); app.dataset.theme = theme; applyTheme(); document.getElementById('theme').textContent = theme === 'paper' ? '◐' : '☼'; };
  document.getElementById('toc-toggle').onclick = () => document.getElementById('toc-popover').classList.toggle('hidden');
  document.getElementById('toc-close').onclick = () => document.getElementById('toc-popover').classList.add('hidden');
  document.getElementById('sync-now').onclick = async () => {
    if (!state.vaultPath) { toast('请先选择 Obsidian 仓库文件夹'); return; }
    try { const result = await api.syncAll(); const failed = result.results.filter((entry) => entry.status === 'error'); toast(failed.length ? `同步失败：${failed[0].message}` : '笔记已同步', failed.length > 0); }
    catch (error) { toast(error.message, true); }
  };
  document.getElementById('open-export')?.addEventListener('click', async () => {
    try { await api.openExport(currentId); } catch (error) { toast(error.message, true); }
  });
  renderNotes();
}

async function openBook(id) {
  if (opening) return;
  opening = true;
  try {
    await leaveReading();
    rendition?.destroy();
    epub?.destroy();
    rendition = null;
    epub = null;
    currentId = id;
    view = 'reader';
    selected = null;
    activeNoteId = null;
    render();
    const base64 = await api.getBook(id);
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    epub = ePub(bytes.buffer);
    const metadata = await epub.loaded.metadata;
    const updates = {};
    if (metadata.title) updates.title = metadata.title;
    if (metadata.creator) updates.author = metadata.creator;
    if (Object.keys(updates).length) {
      state = await api.updateBook(id, updates);
      document.querySelector('.book-heading h2').textContent = currentBook().title;
      document.querySelector('.book-heading p').innerHTML = `正在阅读 <span> / </span> ${escapeHtml(currentBook().author || '未知作者')}`;
      const shelfItem = document.querySelector(`[data-book="${id}"]`);
      if (shelfItem) { shelfItem.querySelector('strong').textContent = short(currentBook().title); shelfItem.querySelector('small').textContent = currentBook().author || '未知作者'; }
    }
    const navigation = await epub.loaded.navigation;
    toc = navigation.toc || [];
    renderToc();
    rendition = epub.renderTo('epub-view', { width: '100%', height: '100%', flow: 'paginated', spread: 'none', allowScriptedContent: false });
    applyTheme();
    rendition.themes.fontSize(`${fontSize}%`);
    rendition.on('selected', (cfi, contents) => {
      const quote = contents.window.getSelection()?.toString().trim() || '';
      if (quote) {
        const section = epub.spine.get(cfi);
        const range = contents.window.getSelection()?.getRangeAt(0);
        selected = { quote, cfi, chapter: chapterAt(toc, section?.href, contents.document, range), chapterIndex: section?.index };
        activeNoteId = null;
        renderSelection();
      }
    });
    rendition.on('relocated', (location) => {
      const cfi = location?.start?.cfi;
      if (!cfi) return;
      const progress = epub.locations.length() ? epub.locations.percentageFromCfi(cfi) : currentBook()?.progress || 0;
      updateProgress(progress);
      clearTimeout(savePositionTimer);
      const bookId = id;
      savePositionTimer = setTimeout(async () => {
        try { state = await api.updateBook(bookId, { cfi, progress }); }
        catch (error) { toast(`保存阅读位置失败：${error.message}`, true); }
      }, 500);
    });
    await rendition.display(currentBook().cfi || undefined);
    document.getElementById('book-loading')?.remove();
    currentBook().notes.forEach(addHighlight);
    const openedEpub = epub;
    const openedRendition = rendition;
    epub.locations.generate(1200).then(() => {
      if (currentId !== id || epub !== openedEpub) return;
      const cfi = openedRendition?.currentLocation()?.start?.cfi;
      if (cfi) updateProgress(epub.locations.percentageFromCfi(cfi));
    }).catch(() => {});
  } catch (error) {
    const loading = document.getElementById('book-loading');
    if (loading) loading.textContent = '无法打开这本 EPUB';
    toast(`打开失败：${error.message}`, true);
  } finally { opening = false; }
}

async function leaveReading() {
  clearTimeout(savePositionTimer);
  const location = rendition?.currentLocation()?.start;
  if (view === 'reader' && currentId && location?.cfi) {
    try { state = await api.updateBook(currentId, { cfi: location.cfi, progress: currentBook()?.progress || 0 }); }
    catch (error) { toast(`保存阅读位置失败：${error.message}`, true); }
  }
}

async function showReview(id) {
  if (opening) return;
  await leaveReading();
  rendition?.destroy(); epub?.destroy(); rendition = null; epub = null;
  view = 'review'; currentId = id; render();
}

async function goHome() {
  if (opening) return;
  await leaveReading();
  rendition?.destroy(); epub?.destroy(); rendition = null; epub = null;
  view = 'shelf'; currentId = null; render();
}

function applyTheme() {
  if (!rendition) return;
  rendition.themes.register('paper', { body: { color: '#2e302e', background: '#faf8f3', 'font-family': 'Georgia, "Noto Serif SC", serif', 'line-height': '1.8' }, '::selection': { background: '#dbead8' } });
  rendition.themes.register('night', { body: { color: '#d9d5c8', background: '#262b2a', 'font-family': 'Georgia, "Noto Serif SC", serif', 'line-height': '1.8' }, '::selection': { background: '#4c6859' } });
  rendition.themes.select(theme);
}

function adjustFont(change) {
  fontSize = Math.max(70, Math.min(170, fontSize + change));
  localStorage.setItem('readerFontSize', fontSize);
  document.querySelector('.font-value').textContent = `${fontSize}%`;
  rendition?.themes.fontSize(`${fontSize}%`);
}

function renderToc() {
  const entries = flattenToc(toc);
  document.getElementById('toc-list').innerHTML = entries.map((item, index) => `<button data-toc="${index}" style="padding-left:${18 + item.depth * 15}px">${escapeHtml(item.label)}</button>`).join('') || '<p class="toc-empty">这本书没有目录</p>';
  document.querySelectorAll('[data-toc]').forEach((node) => node.onclick = () => {
    rendition?.display(entries[Number(node.dataset.toc)].href);
    document.getElementById('toc-popover').classList.add('hidden');
  });
}

function chapterForLocation() {
  const location = rendition?.currentLocation()?.start;
  const contents = rendition?.getContents().find((item) => item.sectionIndex === epub?.spine.get(location?.cfi)?.index);
  let range;
  try { if (location?.cfi && contents) range = contents.range(location.cfi); } catch {}
  return chapterAt(toc, location?.href, contents?.document, range);
}

function updateProgress(value) {
  if (!currentBook()) return;
  currentBook().progress = Number.isFinite(value) ? value : 0;
  document.getElementById('progress-bar').style.width = percent(value);
  document.getElementById('progress-text').textContent = percent(value);
  document.getElementById('page-status').textContent = percent(value);
  const shelf = document.querySelector(`[data-book="${currentId}"] .mini-progress i`);
  if (shelf) shelf.style.width = percent(value);
  document.getElementById('chapter-label').textContent = chapterForLocation();
}

function addHighlight(note) {
  if (!note.cfi || !note.quote || !rendition) return;
  try { rendition.annotations.highlight(note.cfi, { noteId: note.id }, () => editNote(note.id), 'reader-highlight', { fill: '#cddfa9', 'fill-opacity': '0.55', 'mix-blend-mode': 'multiply' }); }
  catch (error) { console.warn('Highlight could not be restored', error); }
}

function renderSelection() {
  const panel = document.getElementById('selection-panel');
  if (!selected) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  panel.innerHTML = `<div class="selection-heading"><span>${activeNoteId ? '编辑笔记' : '新摘录'}</span><button id="selection-close">×</button></div>${selected.quote ? `<blockquote>${escapeHtml(short(selected.quote, 240))}</blockquote>` : ''}<textarea id="note-text" placeholder="写下你的想法…" rows="3">${escapeHtml(selected.text || '')}</textarea><div class="selection-actions"><span>${selected.quote ? '原文将自动划线' : '随手记'}</span><button id="save-note">保存笔记 →</button></div>`;
  document.getElementById('selection-close').onclick = () => { selected = null; activeNoteId = null; renderSelection(); };
  document.getElementById('save-note').onclick = saveNote;
}

async function saveNote() {
  if (!selected) return;
  try {
    const note = { ...selected, id: activeNoteId, text: document.getElementById('note-text').value };
    if (!note.quote && !note.text.trim()) { toast('请先输入笔记内容'); return; }
    const result = await api.saveNote(currentId, note);
    state = result.state;
    selected = null;
    activeNoteId = null;
    renderSelection();
    renderNotes();
    rendition?.annotations.remove(note.cfi, 'highlight');
    currentBook().notes.filter((entry) => entry.cfi === note.cfi).forEach(addHighlight);
    toast(result.sync.status === 'error' ? `笔记已保存，同步失败：${result.sync.message}` : result.sync.status === 'synced' ? '笔记已保存并同步到 Obsidian' : '笔记已保存', result.sync.status === 'error');
  } catch (error) { toast(`保存失败：${error.message}`, true); }
}

function editNote(id) {
  const note = currentBook()?.notes.find((item) => item.id === id);
  if (!note) return;
  activeNoteId = id;
  selected = { quote: note.quote, text: note.text, cfi: note.cfi, chapter: note.chapter, chapterIndex: note.chapterIndex };
  renderSelection();
  document.getElementById('note-text').focus();
}

function renderNotes() {
  const book = currentBook();
  if (!book) return;
  document.getElementById('notes-count').textContent = book.notes.length;
  const list = document.getElementById('notes-list');
  list.innerHTML = book.notes.length ? [...book.notes].reverse().map((note) => `<article class="note-card"><div class="note-card-top"><span>${escapeHtml(note.chapter || '阅读摘录')}</span><button data-more="${note.id}" title="删除笔记">×</button></div>${note.quote ? `<blockquote>${escapeHtml(short(note.quote, 180))}</blockquote>` : ''}${note.text ? `<p>${escapeHtml(short(note.text, 200))}</p>` : ''}<div class="note-card-bottom"><small>${new Date(note.createdAt).toLocaleDateString('zh-CN')}</small><button data-edit="${note.id}">编辑 / 定位 →</button></div></article>`).join('') : '<div class="notes-empty"><span>✎</span><p>这里将收藏你的阅读痕迹</p><small>选中书中的一段文字试试</small></div>';
  list.querySelectorAll('[data-edit]').forEach((node) => node.onclick = () => { const note = book.notes.find((entry) => entry.id === node.dataset.edit); if (note?.cfi) rendition?.display(note.cfi); editNote(node.dataset.edit); });
  list.querySelectorAll('[data-more]').forEach((node) => node.onclick = async () => {
    if (!confirm('删除这条笔记？')) return;
    try {
      const note = book.notes.find((entry) => entry.id === node.dataset.more);
      const result = await api.deleteNote(currentId, node.dataset.more);
      state = result.state;
      if (note?.cfi) rendition?.annotations.remove(note.cfi, 'highlight');
      currentBook().notes.filter((entry) => entry.cfi && entry.cfi === note?.cfi).forEach(addHighlight);
      renderNotes();
      toast(result.sync.status === 'error' ? `笔记已删除，同步失败：${result.sync.message}` : '笔记已删除', result.sync.status === 'error');
    } catch (error) { toast(error.message, true); }
  });
}

document.addEventListener('keydown', (event) => {
  if (!rendition || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if (event.key === 'ArrowLeft') rendition.prev();
  if (event.key === 'ArrowRight') rendition.next();
});

api.getState().then((result) => { state = result; render(); }).catch((error) => { app.textContent = `启动失败：${error.message}`; });
