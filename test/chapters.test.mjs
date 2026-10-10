import test from 'node:test';
import assert from 'node:assert/strict';
import { chapterAt, flattenToc } from '../src/chapters.mjs';

test('nested TOC chapters are resolved for encoded section paths', () => {
  const toc = [{ label: '第一部分', href: 'part.xhtml', subitems: [
    { label: '第二章', href: './Text/第二章.xhtml#heading' }
  ] }];
  assert.equal(chapterAt(toc, 'Text/%E7%AC%AC%E4%BA%8C%E7%AB%A0.xhtml'), '第二章');
  assert.deepEqual(flattenToc(toc).map((item) => item.depth), [0, 1]);
  assert.equal(chapterAt(toc, 'missing.xhtml'), '阅读摘录');
});
