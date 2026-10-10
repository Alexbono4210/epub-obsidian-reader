export function flattenToc(items, depth = 0) {
  return (items || []).flatMap((item) => [{ ...item, depth }, ...flattenToc(item.subitems, depth + 1)]);
}

function decode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function sectionPath(href) {
  return decode(new URL(String(href || '').split('#')[0], 'https://epub.local/').pathname);
}

export function chapterAt(toc, href, document, range) {
  if (!href) return '阅读摘录';
  const section = sectionPath(href);
  const entries = flattenToc(toc).filter((item) => item.href && sectionPath(item.href) === section);
  let match = entries.find((item) => !item.href.includes('#')) || entries[0];
  let previousAnchor;
  if (document && range?.startContainer) {
    for (const item of entries) {
      const fragment = item.href.split('#')[1];
      if (!fragment) continue;
      const anchor = document.getElementById(decode(fragment));
      if (!anchor) continue;
      const position = anchor.compareDocumentPosition(range.startContainer);
      if (anchor !== range.startContainer && !(position & 4)) continue;
      if (!previousAnchor || anchor === previousAnchor || (previousAnchor.compareDocumentPosition(anchor) & 4)) {
        match = item;
        previousAnchor = anchor;
      }
    }
  }
  return match?.label?.trim() || '阅读摘录';
}
