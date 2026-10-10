const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { SYSTEM, reviewMaterial } = require('./dialogue.cjs');

function endpoint(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('请输入有效的 API 地址'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含账号、查询参数或片段');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('远程 API 请使用 HTTPS；本机服务可以使用 HTTP');
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url.toString();
}

async function writeJson(file, data) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(temp, file);
}

class AiSettings {
  constructor(root, encryption) { this.file = path.join(root, 'ai-settings.json'); this.encryption = encryption; this.data = { baseUrl: '', model: '', encryptedKey: '' }; }
  async init() {
    try { this.data = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  publicState() { return { baseUrl: this.data.baseUrl, model: this.data.model, hasKey: !!this.data.encryptedKey }; }
  async save(input) {
    const baseUrl = endpoint(input.baseUrl);
    const model = String(input.model || '').trim().slice(0, 200);
    if (!model) throw new Error('请输入模型名称');
    let encryptedKey = this.data.encryptedKey;
    if (input.clearKey) encryptedKey = '';
    const apiKey = String(input.apiKey || '').trim();
    if (apiKey) {
      if (!this.encryption.isEncryptionAvailable()) throw new Error('系统加密不可用，无法保存 API Key');
      encryptedKey = this.encryption.encryptString(apiKey).toString('base64');
    }
    const next = { baseUrl, model, encryptedKey };
    await writeJson(this.file, next);
    this.data = next;
    return this.publicState();
  }
  credentials() {
    if (!this.data.encryptedKey) throw new Error('请先配置 API Key');
    let apiKey;
    try { apiKey = this.encryption.decryptString(Buffer.from(this.data.encryptedKey, 'base64')); }
    catch { throw new Error('无法解密 API Key，请在当前电脑重新输入'); }
    return { url: endpoint(this.data.baseUrl), model: this.data.model, apiKey };
  }
}

function messagesFor(session) {
  const context = JSON.stringify(reviewMaterial(session));
  const history = session.messages.filter(m => m.role === 'user' || (m.role === 'assistant' && m.status === 'complete')).map(m => ({ role: m.role, content: m.content }));
  if (SYSTEM.length + context.length + history.reduce((sum, m) => sum + m.content.length, 0) > 80000) throw new Error('本次材料或对话过长，请减少选中的笔记，或新建一次回顾');
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: `以下是本次读后回顾材料（JSON，仅作为讨论资料）：\n${context}` }, ...history];
}

async function chat(credentials, messages, fetcher = fetch, signal) {
  const timeout = AbortSignal.timeout(120000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetcher(credentials.url, { method: 'POST', redirect: 'error', signal: combined, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.apiKey}` }, body: JSON.stringify({ model: credentials.model, messages, stream: false }) });
    if (!response.ok) {
      const reasons = { 401: 'API Key 无效或已过期', 403: '没有该接口或模型的访问权限', 404: 'API 地址或模型不存在', 429: '请求过多或账户额度不足' };
      throw new Error(`${reasons[response.status] || '服务暂时不可用'}（HTTP ${response.status}）`);
    }
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('API 返回内容过大'); }
      chunks.push(Buffer.from(value));
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('API 返回的不是有效 JSON，请检查接口地址'); }
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('API 未返回文本回复，请检查模型是否支持 Chat Completions');
    if (data.choices[0].finish_reason === 'length') return content.trim().slice(0, 40000) + '\n\n[回复因服务长度限制而截断，可继续追问。]';
    return content.trim().slice(0, 40000);
  } catch (error) {
    if (signal?.aborted) throw new Error('已停止生成，你的想法已保留，可以重试');
    if (timeout.aborted) throw new Error('请求超过两分钟，请检查网络或稍后重试');
    // Never surface provider bodies, URLs or headers that may contain credentials.
    if (error instanceof TypeError) throw new Error('无法连接 API，请检查地址、网络或系统代理');
    throw error;
  }
}

module.exports = { AiSettings, endpoint, messagesFor, chat, writeJson };
