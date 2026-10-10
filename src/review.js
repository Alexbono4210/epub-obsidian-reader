const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = value => new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export async function mountReview(root, api, state, initialBookId, callbacks) {
  let sessions = [];
  let config;
  let session = null;
  let bookId = initialBookId || state.books[0]?.id;
  let busy = false;
  let actionId = null;
  let editingAction = false;
  let actionDraft = null;
  const drafts = new Map();
  const active = () => root.isConnected;
  const book = () => state.books.find(b => b.id === bookId);
  const draftKey = () => `review-insight-${bookId}`;
  const stash = () => {
    const input = root.querySelector('#insight');
    if (input) localStorage.setItem(draftKey(), input.value);
    const chat = root.querySelector('#chat-input');
    if (chat && session) drafts.set(session.id, chat.value);
    const form = root.querySelector('#action-form');
    if (form) { const data = new FormData(form); actionDraft = { id: actionId, title: data.get('title'), when: data.get('when'), measure: data.get('measure'), result: data.get('result'), done: data.has('done') }; }
  };
  const syncToast = result => {
    if (result.status === 'error') callbacks.toast(`本机已保存，同步失败：${result.message}`, true);
    else if (result.status === 'synced') callbacks.toast('已保存并同步到 Obsidian');
    else callbacks.toast('已保存到本机；连接 Obsidian 后可导出');
  };
  function updateSession(next) {
    session = next;
    const index = sessions.findIndex(s => s.id === next.id);
    if (index >= 0) sessions[index] = next; else sessions.unshift(next);
  }
  function paint() {
    if (!active()) return;
    root.innerHTML = `<header class="topbar"><div class="book-heading"><p>阅读之后 / 留一点启发，试一个行动</p><h2>读后回顾</h2></div><div class="top-actions"><button id="review-home" class="secondary-btn">返回书架</button><button id="ai-settings" class="secondary-btn">API 设置 ${config.hasKey ? '· 已配置' : ''}</button></div></header>
      <div class="review-layout"><aside class="review-index"><label class="field-label" for="review-book">这次回顾哪本书？</label><select id="review-book" ${busy ? 'disabled' : ''}>${state.books.map(b => `<option value="${b.id}" ${b.id === bookId ? 'selected' : ''}>${esc(b.title)}</option>`).join('')}</select><button id="review-read" class="secondary-btn">继续阅读这本书 ↗</button><button id="new-review" class="primary-btn" ${busy ? 'disabled' : ''}>＋ 留下新的启发</button><p class="eyebrow">我的回顾</p><div class="review-history">${sessions.filter(s => s.bookId === bookId).map(s => `<button data-session="${s.id}" class="session-item ${session?.id === s.id ? 'active' : ''}" ${busy ? 'disabled' : ''}><strong>${esc(s.insight.slice(0, 45))}</strong><small>${date(s.createdAt)} · ${s.actions.length} 个行动</small></button>`).join('') || '<p class="muted">还没有回顾，先写一点自己的想法。</p>'}</div></aside>
      ${session ? conversationHtml() : inspirationHtml()}</div>`;
    root.querySelector('#review-home').onclick = () => { stash(); callbacks.home(); };
    root.querySelector('#review-read').onclick = () => { stash(); callbacks.read(bookId); };
    root.querySelector('#ai-settings').onclick = settingsDialog;
    root.querySelector('#review-book').onchange = event => { stash(); bookId = event.target.value; session = null; actionId = null; editingAction = false; actionDraft = null; paint(); };
    root.querySelector('#new-review').onclick = () => { stash(); session = null; actionId = null; editingAction = false; actionDraft = null; paint(); };
    root.querySelectorAll('[data-session]').forEach(node => node.onclick = () => { stash(); session = sessions.find(s => s.id === node.dataset.session); actionId = null; editingAction = false; actionDraft = null; paint(); });
    if (session) bindConversation(); else bindInspiration();
  }
  function inspirationHtml() {
    const value = localStorage.getItem(draftKey()) || '';
    return `<section class="inspiration-page"><p class="eyebrow">START WITH YOUR OWN THOUGHTS</p><h1>这次阅读，<br>什么触动了你？</h1><p class="intro">读到这里已经有一点启发，就可以停下来聊聊。<br>不需要读到 100%，也不用把想法写得很完整。</p><label class="field-label" for="insight">先留下自己的想法</label><textarea id="insight" maxlength="12000" rows="5" placeholder="这段让我想到……我想试着……但还没想清楚……">${esc(value)}</textarea><details class="source-picker"><summary>选择讨论材料 · ${book()?.notes.length || 0} 条摘录与笔记</summary><p class="muted">只发送勾选的材料。可以不选，直接讨论自己的想法。</p><div class="source-options">${(book()?.notes || []).map(n => `<label class="source-option"><input type="checkbox" name="source-note" value="${n.id}"><span><strong>${esc(n.chapter || '阅读摘录')}</strong>${n.quote ? `<blockquote>${esc(n.quote.slice(0, 300))}</blockquote>` : ''}${n.text ? `<p>${esc(n.text.slice(0, 300))}</p>` : ''}</span></label>`).join('') || '<p class="muted">这本书还没有笔记，你仍可以留下自己的启发。</p>'}</div></details><p class="send-description">开始时先保存在本机。点击发送后，书名、你的启发、选中笔记和本次对话会发往你配置的 API；不会上传整本 EPUB 或其他 Obsidian 文件。</p><button id="start-review" class="primary-btn">保存启发，进入对话 →</button><p class="muted small">没有启发时，可以直接返回书架。</p></section>`;
  }
  function bindInspiration() {
    root.querySelector('#insight').oninput = stash;
    root.querySelector('#start-review').onclick = async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const insight = root.querySelector('#insight').value.trim();
        const noteIds = [...root.querySelectorAll('[name="source-note"]:checked')].map(n => n.value);
        const next = await api.createReview(bookId, { insight, noteIds });
        localStorage.removeItem(draftKey());
        updateSession(next); paint();
      } catch (error) { callbacks.toast(error.message, true); button.disabled = false; }
    };
  }
  function conversationHtml() {
    const failed = session.messages.at(-1)?.status === 'failed';
    return `<section class="conversation"><div class="conversation-heading"><div><p class="eyebrow">ONE IDEA, ONE SMALL STEP</p><h3>${esc(session.bookTitle)}</h3></div><button id="export-review" class="secondary-btn">保存回顾到 Obsidian ↗</button></div><details class="session-context"><summary>我的启发与讨论材料 · ${session.notes.length} 条笔记</summary><p class="preserve-lines">${esc(session.insight)}</p>${session.notes.map(n => `<div class="context-note"><strong>${esc(n.chapter || '阅读摘录')}</strong><blockquote>${esc(n.quote)}</blockquote><p>${esc(n.text)}</p></div>`).join('')}</details><div id="chat-log" class="chat-log"><article class="message user inspiration"><small>我的启发</small><div>${esc(session.insight)}</div></article>${session.messages.map(m => `<article class="message ${m.role}"><small>${m.role === 'user' ? '我' : 'AI · 请结合原文判断'}</small><div>${esc(m.content)}</div>${m.role === 'assistant' ? `<button data-bookmark="${m.id}" class="bookmark-btn">${m.saved ? '✓ 已保留到回顾 · 点击取消' : '＋ 保留这条回复到回顾'}</button>` : ''}${m.status === 'failed' ? `<p class="request-error">${esc(m.error || '上次回复中断，想法已保留。')}</p>` : ''}</article>`).join('')}${!session.messages.length ? '<div class="chat-welcome">从这一点启发开始，先聊清楚，再决定要试什么。<button id="discuss-insight" class="secondary-btn">请陪我讨论这点启发 →</button></div>' : ''}${busy ? '<div class="generating" role="status">正在等待 AI 回复… <button id="cancel-generation">停止等待</button></div>' : ''}</div><form id="chat-form" class="chat-compose"><textarea id="chat-input" rows="2" maxlength="12000" placeholder="继续说说你的想法，或讨论准备尝试的行动…" ${busy || failed ? 'disabled' : ''}>${esc(drafts.get(session.id) || '')}</textarea><div class="compose-bottom"><span>${config.hasKey ? '发送至 ' + esc(new URL(config.baseUrl).host) : '先在 API 设置中填写接口、模型和 Key'} · 每次聚焦一点</span>${failed ? '<button type="button" id="retry-chat" class="primary-btn">重试上一条</button>' : `<button class="primary-btn" type="submit" ${busy ? 'disabled' : ''}>发送 →</button>`}</div></form></section>
      <aside class="action-panel"><p class="eyebrow">PUT IT INTO PRACTICE</p><h3>行动与回看</h3><p class="muted">把一点启发放进生活里，试过后再回来记录。</p><div class="action-list">${session.actions.map(a => `<article class="action-card"><span class="action-status">${a.done ? '✓ 已执行' : '待尝试'}</span><h4>${esc(a.title)}</h4><p>何时 / 情境：${esc(a.when || '待确定')}</p><p>如何观察：${esc(a.measure || '待确定')}</p>${a.result ? `<p class="action-result">回看：${esc(a.result)}</p>` : ''}<button data-action="${a.id}" class="secondary-btn">编辑 / 记录结果</button></article>`).join('')}</div><button id="add-action" class="secondary-btn">＋ 写下一个小行动</button><div id="action-editor"></div><p class="send-description">行动由你确认、执行和回看。AI 回复不会自动变成行动；只导出你选择保留的回复。再次发送消息时，也会把本次行动与结果作为讨论材料。</p></aside>`;
  }
  function bindConversation() {
    root.querySelector('#chat-form').onsubmit = event => { event.preventDefault(); send(root.querySelector('#chat-input').value); };
    root.querySelector('#chat-input').oninput = stash;
    root.querySelector('#chat-input').onkeydown = event => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); send(event.target.value); } };
    root.querySelector('#discuss-insight')?.addEventListener('click', () => send('请围绕我的启发陪我讨论，先帮我把想法说清楚，一次只讨论一个点。'));
    root.querySelector('#retry-chat')?.addEventListener('click', () => send('', true));
    root.querySelector('#cancel-generation')?.addEventListener('click', () => api.cancelReview(session.id).catch(e => callbacks.toast(e.message, true)));
    root.querySelectorAll('[data-bookmark]').forEach(node => node.onclick = async () => {
      node.disabled = true;
      try { const result = await api.bookmarkReply(session.id, node.dataset.bookmark); stash(); updateSession(result.session); paint(); syncToast(result.sync); }
      catch (error) { callbacks.toast(error.message, true); node.disabled = false; }
    });
    root.querySelector('#export-review').onclick = async () => {
      try { syncToast(await api.openReviewExport(session.id)); } catch (error) { callbacks.toast(error.message, true); }
    };
    root.querySelectorAll('[data-action]').forEach(node => node.onclick = () => { actionDraft = null; editAction(node.dataset.action); });
    root.querySelector('#add-action').onclick = () => { actionDraft = null; editAction(null); };
    if (editingAction) editAction(actionId);
    const log = root.querySelector('#chat-log'); log.scrollTop = log.scrollHeight;
  }
  async function send(content, retry = false) {
    if (busy || (!retry && !content.trim())) return;
    if (!config.hasKey) { settingsDialog(); return; }
    stash();
    busy = true;
    const id = session.id;
    // Keep the typed draft until the main process has persisted the message.
    paint();
    try {
      const result = await api.sendReview(id, content, retry);
      drafts.delete(id);
      updateSession(result.session);
      if (result.error) callbacks.toast(result.error, true);
    } catch (error) { callbacks.toast(error.message, true); }
    finally { busy = false; paint(); }
  }
  function editAction(id) {
    actionId = id;
    editingAction = true;
    const action = actionDraft || session.actions.find(a => a.id === id) || {};
    const editor = root.querySelector('#action-editor');
    editor.innerHTML = `<form id="action-form" class="action-editor"><label>准备做什么<textarea name="title" required rows="2" maxlength="2000">${esc(action.title)}</textarea></label><label>何时 / 什么情境<input name="when" maxlength="2000" value="${esc(action.when)}" placeholder="例如：接下来三天，开始工作前"></label><label>如何观察结果<input name="measure" maxlength="2000" value="${esc(action.measure)}" placeholder="例如：记录分心次数"></label><label>执行后的发现<textarea name="result" rows="3" maxlength="8000" placeholder="试过以后再填写…">${esc(action.result)}</textarea></label><label class="check-label"><input type="checkbox" name="done" ${action.done ? 'checked' : ''}> 我已经尝试执行</label><div class="dialog-actions"><button type="button" id="cancel-action" class="secondary-btn">取消</button><button class="primary-btn">保存行动</button></div></form>`;
    editor.querySelector('#cancel-action').onclick = () => { actionId = null; editingAction = false; actionDraft = null; editor.innerHTML = ''; };
    editor.querySelector('#action-form').onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget;
      form.querySelector('button[type="submit"], .primary-btn').disabled = true;
      const data = new FormData(form);
      try {
        const result = await api.saveAction(session.id, { id, title: data.get('title'), when: data.get('when'), measure: data.get('measure'), result: data.get('result'), done: data.has('done') });
        stash(); updateSession(result.session); actionId = null; editingAction = false; actionDraft = null; paint(); syncToast(result.sync);
      } catch (error) { callbacks.toast(error.message, true); form.querySelector('.primary-btn').disabled = false; }
    };
    editor.scrollIntoView({ block: 'nearest' });
  }
  function settingsDialog() {
    if (document.querySelector('#api-dialog')) return;
    const dialog = document.createElement('dialog');
    dialog.id = 'api-dialog'; dialog.className = 'api-dialog';
    dialog.innerHTML = `<form id="api-form"><p class="eyebrow">AI CONNECTION</p><h2>配置你的 API</h2><p class="muted">支持 OpenAI 兼容的 Chat Completions 接口。</p><label>接口地址<input name="baseUrl" type="url" required value="${esc(config.baseUrl)}" placeholder="https://你的服务地址/v1"></label><p class="muted small">可填基础地址或完整的 /chat/completions 地址。</p><label>模型名称<input name="model" required value="${esc(config.model)}" placeholder="填写服务商提供的模型 ID"></label><label>API Key<input name="apiKey" type="password" autocomplete="off" placeholder="${config.hasKey ? '已加密保存；留空保留当前 Key' : '输入 API Key'}"></label>${config.hasKey ? '<label class="check-label"><input type="checkbox" name="clearKey">删除已保存的 Key</label>' : ''}<p class="send-description">Key 使用 Windows 系统加密保存，只用于你配置的接口。连接测试会发送一句简短问候，可能产生少量 API 费用。</p><p id="api-status" role="status"></p><div class="dialog-actions"><button type="button" id="close-api" class="secondary-btn">关闭</button><button type="button" id="test-api" class="secondary-btn">保存并测试</button><button class="primary-btn" type="submit">保存配置</button></div></form>`;
    document.body.append(dialog); dialog.showModal();
    dialog.addEventListener('close', () => dialog.remove());
    dialog.querySelector('#close-api').onclick = () => dialog.close();
    const save = async test => {
      const form = dialog.querySelector('form');
      if (!form.reportValidity()) return;
      const data = new FormData(form);
      const status = dialog.querySelector('#api-status');
      const buttons = dialog.querySelectorAll('button'); buttons.forEach(b => b.disabled = true);
      try {
        config = await api.configureAi({ baseUrl: data.get('baseUrl'), model: data.get('model'), apiKey: data.get('apiKey'), clearKey: data.has('clearKey') });
        form.elements.apiKey.value = ''; form.elements.apiKey.placeholder = config.hasKey ? '已加密保存；留空保留当前 Key' : '输入 API Key';
        form.elements.clearKey && (form.elements.clearKey.checked = false);
        paint();
        if (test) { status.textContent = '配置已保存，正在测试连接…'; await api.testAi(); status.textContent = '连接成功，可以开始对话。'; }
        else { dialog.close(); callbacks.toast('API 配置已保存'); }
      } catch (error) { status.textContent = error.message; status.className = 'request-error'; }
      finally { buttons.forEach(b => b.disabled = false); }
    };
    dialog.querySelector('#api-form').onsubmit = event => { event.preventDefault(); save(false); };
    dialog.querySelector('#test-api').onclick = () => save(true);
  }
  root.innerHTML = '<div class="review-loading">正在打开回顾…</div>';
  const observer = new MutationObserver(() => {
    if (active()) return;
    if (busy && session) api.cancelReview(session.id).catch(() => {});
    observer.disconnect();
  });
  observer.observe(document.getElementById('app'), { childList: true, subtree: true });
  try { [sessions, config] = await Promise.all([api.listReviews(), api.aiSettings()]); paint(); }
  catch (error) { if (active()) root.textContent = `打开回顾失败：${error.message}`; }
}
