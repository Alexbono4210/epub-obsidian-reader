const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { cleanName, replaceManaged } = require('./store.cjs');
const { writeJson } = require('./ai.cjs');
const START = '<!-- EPUB_REFLECTION_START -->';
const END = '<!-- EPUB_REFLECTION_END -->';
const safe = value => String(value || '').replaceAll('<!-- EPUB_', '&lt;!-- EPUB_');
const text = (value, max) => String(value || '').trim().slice(0, max);

class Reflections {
  constructor(root) { this.file = path.join(root, 'reflections.json'); this.sessions = []; this.queue = Promise.resolve(); }
  enqueue(work) { const run = this.queue.then(work); this.queue = run.catch(() => {}); return run; }
  async init() {
    try { this.sessions = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // A closed app cannot still be generating a response.
    for (const session of this.sessions) for (const message of session.messages) if (message.status === 'pending') message.status = 'failed';
    await this.persist();
  }
  persist() { return writeJson(this.file, this.sessions); }
  get(id) { const session = this.sessions.find(s => s.id === id); if (!session) throw new Error('找不到这次回顾'); return session; }
  async create(book, input) {
    const insight = text(input.insight, 12000);
    if (!insight) throw new Error('先写一点自己的想法，不需要完整或成熟');
    const ids = new Set(Array.isArray(input.noteIds) ? input.noteIds : []);
    const notes = book.notes.filter(n => ids.has(n.id)).map(n => ({ id: n.id, chapter: n.chapter, quote: n.quote, text: n.text, cfi: n.cfi }));
    if (JSON.stringify(notes).length + insight.length > 50000) throw new Error('选中的笔记太多，请选出与这次启发最相关的部分');
    const session = { id: crypto.randomUUID(), bookId: book.id, bookTitle: book.title, author: book.author, insight, notes, createdAt: new Date().toISOString(), messages: [], actions: [] };
    this.sessions.unshift(session);
    await this.persist();
    return session;
  }
  async prepare(id, content, retry = false) {
    const session = this.get(id);
    const last = session.messages.at(-1);
    if (last?.role === 'user' && last.status === 'pending') throw new Error('请等待当前回复');
    if (retry) {
      if (last?.role !== 'user' || last.status !== 'failed') throw new Error('没有需要重试的消息');
      last.status = 'pending'; last.error = '';
    } else {
      if (last?.role === 'user' && last.status === 'failed') throw new Error('上一条消息尚未收到回复，请先重试');
      content = text(content, 12000);
      if (!content) throw new Error('请输入你想讨论的内容');
      session.messages.push({ id: crypto.randomUUID(), role: 'user', content, status: 'pending', createdAt: new Date().toISOString() });
    }
    await this.persist();
    return session;
  }
  async complete(id, content) {
    const session = this.get(id);
    session.messages.at(-1).status = 'complete';
    session.messages.push({ id: crypto.randomUUID(), role: 'assistant', content, status: 'complete', saved: false, createdAt: new Date().toISOString() });
    await this.persist(); return session;
  }
  async fail(id, error) { const session = this.get(id); Object.assign(session.messages.at(-1), { status: 'failed', error }); await this.persist(); return session; }
  async bookmark(id, messageId) {
    const session = this.get(id);
    const message = session.messages.find(m => m.id === messageId && m.role === 'assistant');
    if (!message) throw new Error('找不到这条 AI 回复');
    message.saved = !message.saved;
    await this.persist(); return session;
  }
  async action(id, input) {
    const session = this.get(id);
    const existing = input.id && session.actions.find(a => a.id === input.id);
    if (input.id && !existing) throw new Error('找不到这个行动');
    const title = text(input.title, 2000);
    if (!title) throw new Error('请填写准备做什么');
    const saved = { id: existing?.id || crypto.randomUUID(), title, when: text(input.when, 2000), measure: text(input.measure, 2000), result: text(input.result, 8000), done: !!input.done };
    if (existing) Object.assign(existing, saved); else session.actions.push(saved);
    await this.persist(); return session;
  }
  async sync(session, vault) {
    if (!vault) return { status: 'not-configured' };
    try {
      const folder = path.join(vault, 'EPUB 阅读笔记', 'V0.2', '读后回顾');
      await fs.mkdir(folder, { recursive: true });
      const file = path.join(folder, `${cleanName(session.bookTitle)} - 回顾 ${session.id.slice(0, 8)}.md`);
      const lines = [`# ${safe(session.bookTitle)} · 读后回顾`, '', '## 我的启发', '', safe(session.insight), '', '## 讨论材料', ''];
      for (const note of session.notes) {
        lines.push(`### ${safe(note.chapter || '阅读摘录')}`, '');
        if (note.quote) lines.push(...safe(note.quote).split(/\r?\n/).map(l => `> ${l}`), '');
        if (note.text) lines.push(safe(note.text), '');
      }
      lines.push('## 我选择保留的 AI 对话', '');
      session.messages.forEach((message, index) => {
        if (message.role !== 'assistant' || !message.saved) return;
        lines.push(`**我的提问**：${safe(session.messages[index - 1]?.content)}`, '', '**AI 回复（需要自己判断）**', '', safe(message.content), '');
      });
      lines.push('## 行动与回看', '');
      for (const action of session.actions) lines.push(`- [${action.done ? 'x' : ' '}] ${safe(action.title)}`, `  - 何时 / 情境：${safe(action.when) || '待确定'}`, `  - 如何观察：${safe(action.measure) || '待确定'}`, `  - 执行结果：${safe(action.result) || '待回看'}`, '');
      let existing = '';
      try { existing = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const content = replaceManaged(existing, lines.join('\n') + '\n', START, END);
      if (content === null) throw new Error('回顾文件的管理标记缺失，已保留原文件');
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temp, content, 'utf8'); await fs.rename(temp, file);
      return { status: 'synced', path: file };
    } catch (error) { return { status: 'error', message: error.message }; }
  }
}
module.exports = { Reflections };
