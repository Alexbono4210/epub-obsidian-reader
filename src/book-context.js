import ePub from 'epubjs';
import { flattenToc } from './chapters.mjs';

const LIMIT = 1200;
const normalize = value => String(value || '').normalize('NFC').replace(/[\s\u200b\ufeff]+/g, '');
const blocked = new Set(['script', 'style', 'noscript', 'template', 'nav']);
const blocks = new Set(['p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'li', 'blockquote', 'br', 'tr']);

function plainText(fragment) {
  let text = '';
  const walk = node => {
    if (node.nodeType === 3) { text += node.nodeValue; return; }
    const tag = node.localName?.toLowerCase();
    if (blocked.has(tag) || node.hasAttribute?.('hidden') || node.getAttribute?.('aria-hidden') === 'true') return;
    if (blocks.has(tag)) text += '\n';
    for (const child of node.childNodes || []) walk(child);
    if (blocks.has(tag)) text += '\n';
  };
  walk(fragment);
  return text.replace(/[\t\r ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const sectionPath = href => {
  const path = new URL(String(href || '').split('#')[0], 'https://epub.local/').pathname;
  try { return decodeURIComponent(path); } catch { return path; }
};
const decodeFragment = value => {
  try { return decodeURIComponent(value); } catch { return value; }
};

// TOC chapters may share a spine document. Compare actual DOM boundaries so
// their text does not silently become context for a neighbouring chapter.
export function chapterBounds(toc, href, document, range) {
  const body = document.querySelector('body');
  if (!body || !range || !body.contains(range.startContainer) || !body.contains(range.endContainer)) throw new Error('无法定位到这一节的正文');
  const pointRange = point => {
    const result = document.createRange();
    result.setStart(point.container, point.offset);
    result.collapse(true);
    return result;
  };
  const compare = (left, right) => pointRange(left).compareBoundaryPoints(0, pointRange(right));
  const bodyStart = { container: body, offset: 0 };
  const bodyEnd = { container: body, offset: body.childNodes.length };
  const start = { container: range.startContainer, offset: range.startOffset };
  const end = { container: range.endContainer, offset: range.endOffset };
  const entries = flattenToc(toc).filter(item => item.href && sectionPath(item.href) === sectionPath(href));
  const anchors = [];
  for (const item of entries) {
    const hash = item.href.indexOf('#');
    const fragment = hash < 0 ? '' : decodeFragment(item.href.slice(hash + 1));
    const anchor = fragment ? document.getElementById(fragment) : body;
    if (!anchor || !body.contains(anchor)) continue;
    let point = bodyStart;
    if (anchor !== body) {
      const anchorRange = document.createRange();
      anchorRange.setStartBefore(anchor);
      point = { container: anchorRange.startContainer, offset: anchorRange.startOffset };
    }
    anchors.push({ point, label: item.label?.trim() || '未命名章节' });
  }
  anchors.sort((a, b) => compare(a.point, b.point));
  // A parent and its first subchapter can refer to the same anchor. The last
  // TOC entry is the more specific label, consistent with chapter selection.
  const boundaries = [];
  for (const anchor of anchors) {
    if (boundaries.length && compare(boundaries.at(-1).point, anchor.point) === 0) boundaries[boundaries.length - 1] = anchor;
    else boundaries.push(anchor);
  }
  let startIndex = -1;
  let endIndex = -1;
  boundaries.forEach((anchor, index) => {
    if (compare(anchor.point, start) <= 0) startIndex = index;
    // The end of a nonempty selection is exclusive: ending at a chapter
    // boundary does not mean that the following chapter was selected.
    if (compare(anchor.point, end) < 0) endIndex = index;
  });
  endIndex = range.collapsed ? startIndex : Math.max(startIndex, endIndex);
  const fallback = entries.length ? '章节前文' : '阅读摘录';
  const firstChapter = boundaries[startIndex]?.label || fallback;
  const lastChapter = boundaries[endIndex]?.label || fallback;
  const crossesChapters = startIndex !== endIndex;
  return {
    start: boundaries[startIndex]?.point || bodyStart,
    end: boundaries[endIndex + 1]?.point || bodyEnd,
    chapter: crossesChapters ? `${firstChapter} → ${lastChapter}` : firstChapter,
    crossesChapters
  };
}

export function extractAroundRange(document, range, quote, bounds = {}) {
  const body = document.querySelector('body');
  if (!body || !range || !body.contains(range.startContainer) || !body.contains(range.endContainer)) throw new Error('无法定位到这一节的正文');
  if (quote && normalize(range.toString()) !== normalize(quote)) throw new Error('保存的位置与摘录不一致，未自动补充上下文');
  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(body);
  if (bounds.start) beforeRange.setStart(bounds.start.container, bounds.start.offset);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const afterRange = document.createRange();
  afterRange.selectNodeContents(body);
  if (bounds.end) afterRange.setEnd(bounds.end.container, bounds.end.offset);
  afterRange.setStart(range.endContainer, range.endOffset);
  const before = plainText(beforeRange.cloneContents());
  const after = plainText(afterRange.cloneContents());
  return { before: before.slice(-LIMIT), after: after.slice(0, LIMIT), hasMoreBefore: before.length > LIMIT, hasMoreAfter: after.length > LIMIT };
}

export function createContextLoader(api) {
  const books = new Map();
  const cache = new Map();
  let disposed = false;
  let queue = Promise.resolve();
  const timeout = async work => {
    let timer;
    try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('读取原文超时，可以只使用摘录继续')), 15000); })]); }
    finally { clearTimeout(timer); }
  };
  async function open(id) {
    if (!books.has(id)) books.set(id, (async () => {
      const base64 = await api.getBook(id);
      if (disposed) throw new Error('回顾页面已关闭');
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const epub = ePub(bytes.buffer, { replacements: 'none' });
      try { await timeout(epub.ready); }
      catch (error) { epub.destroy(); throw error; }
      if (disposed) { epub.destroy(); throw new Error('回顾页面已关闭'); }
      return epub;
    })());
    return books.get(id);
  }
  return {
    get(bookId, note) {
      const key = JSON.stringify([bookId, note.id, note.cfi, note.quote]);
      if (cache.has(key)) return cache.get(key);
      const work = queue.then(async () => {
        try {
          if (disposed) throw new Error('回顾页面已关闭');
          if (!note.cfi) throw new Error('这条笔记没有保存原文位置，可只使用摘录讨论');
          const epub = await timeout(open(bookId));
          const section = epub.spine.get(note.cfi);
          if (!section) throw new Error('原文位置已失效，可只使用摘录讨论');
          const range = await timeout(epub.getRange(note.cfi));
          const navigation = await epub.loaded.navigation;
          const bounds = chapterBounds(navigation.toc, section.href, section.document, range);
          const text = extractAroundRange(section.document, range, note.quote, bounds);
          return { status: 'ready', cfi: note.cfi, quote: note.quote || '', chapter: bounds.chapter === '阅读摘录' ? note.chapter || bounds.chapter : bounds.chapter, crossesChapters: bounds.crossesChapters, ...text };
        } catch (error) { return { status: 'unavailable', message: error?.message || '未能提取原文上下文，可只使用摘录讨论' }; }
      });
      queue = work.catch(() => {});
      cache.set(key, work);
      return work;
    },
    dispose() {
      disposed = true;
      for (const work of books.values()) work.then(epub => epub.destroy()).catch(() => {});
      books.clear(); cache.clear();
    }
  };
}
