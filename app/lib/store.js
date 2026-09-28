'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TEXT_CHARS = 200000;

function uid() {
  return crypto.randomUUID();
}

function nowISO() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: 1,
    settings: {
      defaultSystemPrompt: '你是一个乐于助人的 AI 助手，回答简洁准确，使用 Markdown 排版。',
      defaultTemperature: 0.7,
      historyLimit: 30,
      showReasoning: true,
      theme: 'system',
    },
    connections: [],
    activeConnectionId: null,
    conversations: [],
  };
}

function summarize(text, max = 24) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '新对话';
  return t.length > max ? t.slice(0, max) + '…' : t;
}

// ---------- 消息版本（重新回答 / 对话分支） ----------
// 一条消息可以有多个版本：variants[i] 存该版本的内容，activeVariant 指向当前生效的那个。
// 消息顶层的 content/reasoning/error 始终镜像当前版本 —— 这样渲染、上下文拼装、
// 旧数据读取的写法全都不用改。

function makeVariant(src) {
  return {
    content: (src && src.content) || '',
    reasoning: (src && src.reasoning) || '',
    error: (src && src.error) || null,
    createdAt: (src && src.createdAt) || nowISO(),
  };
}

function clampIndex(value, total) {
  const i = Math.floor(Number(value));
  if (!Number.isFinite(i) || i < 0) return 0;
  return Math.min(i, Math.max(0, total - 1));
}

function activeVariant(msg) {
  if (!msg || !Array.isArray(msg.variants) || !msg.variants.length) return null;
  return msg.variants[clampIndex(msg.activeVariant, msg.variants.length)] || null;
}

// 版本 → 顶层（单向：顶层不回头覆盖版本内容）
function syncActiveVariant(msg) {
  const v = activeVariant(msg);
  if (!v) return msg;
  msg.content = v.content || '';
  msg.reasoning = v.reasoning || '';
  msg.error = v.error || null;
  return msg;
}

// 没有 variants 的老消息在这里自动补成「单版本」
function ensureVariants(msg) {
  if (!msg) return null;
  if (!Array.isArray(msg.variants) || !msg.variants.length) {
    msg.variants = [makeVariant(msg)];
  }
  msg.activeVariant = clampIndex(msg.activeVariant, msg.variants.length);
  return syncActiveVariant(msg);
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'data.json');
    this.filesDir = path.join(dir, 'files');
    fs.mkdirSync(this.filesDir, { recursive: true });
    this.readWarning = null; // 读文件出问题时给界面用的提示文案
    this.state = this._read();
    this._timer = null;
    this._dirty = false;
  }

  /** 把读不出来的文件另存一份，避免下一次保存把它彻底覆盖掉 */
  _quarantine() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = this.file + '.unreadable-' + stamp;
    try {
      fs.copyFileSync(this.file, target);
      return target;
    } catch (err) {
      console.error('[store] 损坏文件另存失败:', err);
      return null;
    }
  }

  _read() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.readWarning = '读取数据文件失败：' + err.message;
        console.error('[store] ' + this.readWarning);
      }
      return defaultState(); // 第一次运行没有文件，正常
    }

    // 去掉 BOM。
    // 记事本、PowerShell 的 Set-Content -Encoding UTF8 等都会写 BOM，
    // 而 JSON.parse 遇到 BOM 会直接抛错 —— 以前这里会静默当成空数据，
    // 接着一保存就把用户填好的接口和对话覆盖没了。
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    if (!raw.trim()) return defaultState(); // 空文件按首次运行处理，不算损坏

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const backupPath = this._quarantine();
      this.readWarning = '数据文件无法解析（' + err.message + '）' +
        (backupPath ? '，原文件已另存为 ' + path.basename(backupPath) : '') +
        '，本次以空数据启动';
      console.error('[store] ' + this.readWarning);
      return defaultState();
    }

    const base = defaultState();
    const state = {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
      connections: Array.isArray(parsed.connections) ? parsed.connections : [],
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
    };
    // 老数据迁移：给没有版本信息的消息补上单版本
    for (const conv of state.conversations) {
      if (!Array.isArray(conv.messages)) conv.messages = [];
      for (const msg of conv.messages) ensureVariants(msg);
    }
    return state;
  }

  saveNow() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._dirty = false;
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] 保存失败:', err);
    }
  }

  save() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.saveNow();
    }, 250);
  }

  // ---------- settings ----------
  updateSettings(patch) {
    this.state.settings = { ...this.state.settings, ...(patch || {}) };
    this.save();
    return this.state.settings;
  }

  // ---------- connections ----------
  addConnection(data) {
    const conn = {
      id: uid(),
      name: data.name || '新接口',
      type: data.type || 'openai',
      baseUrl: data.baseUrl || '',
      apiKey: data.apiKey || '',
      model: data.model || '',
      createdAt: nowISO(),
    };
    this.state.connections.push(conn);
    if (!this.state.activeConnectionId) this.state.activeConnectionId = conn.id;
    this.save();
    return conn;
  }

  updateConnection(id, patch) {
    const conn = this.state.connections.find((c) => c.id === id);
    if (!conn) return null;
    Object.assign(conn, patch || {});
    this.save();
    return conn;
  }

  deleteConnection(id) {
    this.state.connections = this.state.connections.filter((c) => c.id !== id);
    if (this.state.activeConnectionId === id) {
      this.state.activeConnectionId = this.state.connections[0] ? this.state.connections[0].id : null;
    }
    this.save();
  }

  getConnection(id) {
    return this.state.connections.find((c) => c.id === id) || null;
  }

  setActiveConnection(id) {
    this.state.activeConnectionId = id || null;
    this.save();
  }

  // ---------- conversations ----------
  createConversation(opts = {}) {
    const conv = {
      id: uid(),
      title: opts.title || '新对话',
      createdAt: nowISO(),
      updatedAt: nowISO(),
      connectionId: opts.connectionId || this.state.activeConnectionId || null,
      model: opts.model || '',
      systemPrompt: opts.systemPrompt != null ? opts.systemPrompt : this.state.settings.defaultSystemPrompt,
      temperature: opts.temperature != null ? opts.temperature : this.state.settings.defaultTemperature,
      messages: [],
    };
    this.state.conversations.unshift(conv);
    this.save();
    return conv;
  }

  getConversation(id) {
    return this.state.conversations.find((c) => c.id === id) || null;
  }

  updateConversation(id, patch) {
    const conv = this.getConversation(id);
    if (!conv) return null;
    Object.assign(conv, patch || {});
    conv.updatedAt = nowISO();
    this.save();
    return conv;
  }

  deleteConversation(id) {
    const conv = this.getConversation(id);
    this.state.conversations = this.state.conversations.filter((c) => c.id !== id);
    this.save();
    // 顺带清理该对话的附件文件
    if (conv) {
      for (const msg of conv.messages || []) {
        for (const att of msg.attachments || []) {
          if (att && att.path) {
            try { fs.unlinkSync(att.path); } catch { /* ignore */ }
          }
        }
      }
    }
    return true;
  }

  // ---------- messages ----------
  appendMessage(conversationId, msg) {
    const conv = this.getConversation(conversationId);
    if (!conv) return null;
    const message = {
      id: msg.id || uid(),
      role: msg.role,
      content: msg.content || '',
      reasoning: msg.reasoning || '',
      attachments: msg.attachments || [],
      error: msg.error || null,
      createdAt: nowISO(),
    };
    message.variants = [makeVariant(message)];
    message.activeVariant = 0;
    conv.messages.push(message);
    conv.updatedAt = nowISO();
    if (message.role === 'user' && (conv.title === '新对话' || !conv.title)) {
      const first = message.content || (message.attachments[0] && message.attachments[0].name) || '';
      conv.title = summarize(first);
    }
    this.save();
    return message;
  }

  updateMessage(conversationId, messageId, patch) {
    const conv = this.getConversation(conversationId);
    if (!conv) return null;
    const msg = conv.messages.find((m) => m.id === messageId);
    if (!msg) return null;
    ensureVariants(msg);
    Object.assign(msg, patch || {});
    // 内容类字段同时写进当前版本，保证「版本 ↔ 顶层」一致
    const v = activeVariant(msg);
    if (v && patch) {
      if ('content' in patch) v.content = patch.content || '';
      if ('reasoning' in patch) v.reasoning = patch.reasoning || '';
      if ('error' in patch) v.error = patch.error || null;
    }
    conv.updatedAt = nowISO();
    this.save();
    return msg;
  }

  // 追加一个新版本并设为当前（用于「重新回答」和「编辑提问开分支」）
  addVariant(conversationId, messageId, src) {
    const conv = this.getConversation(conversationId);
    if (!conv) return null;
    const msg = conv.messages.find((m) => m.id === messageId);
    if (!msg) return null;
    ensureVariants(msg);
    msg.variants.push(makeVariant(src || {}));
    msg.activeVariant = msg.variants.length - 1;
    syncActiveVariant(msg);
    conv.updatedAt = nowISO();
    // 第一条提问被改写时，对话标题跟着走（标题本来就是从它生成的）
    const firstUser = conv.messages.find((m) => m.role === 'user');
    if (msg.role === 'user' && firstUser && firstUser.id === msg.id) {
      conv.title = summarize(msg.content) || conv.title;
    }
    this.save();
    return { message: msg, variantIndex: msg.activeVariant, changed: [msg], title: conv.title };
  }

  // 切换当前版本。紧接着的「提问 / 回答」成对消息会一起对齐到同一版本号 —— 这就是分支。
  setActiveVariant(conversationId, messageId, index, opts = {}) {
    const conv = this.getConversation(conversationId);
    if (!conv) return null;
    const at = conv.messages.findIndex((m) => m.id === messageId);
    if (at < 0) return null;
    const msg = conv.messages[at];
    ensureVariants(msg);
    const i = Math.floor(Number(index));
    if (!Number.isFinite(i) || i < 0 || i >= msg.variants.length) return null;
    msg.activeVariant = i;
    syncActiveVariant(msg);
    const changed = [msg];
    if (opts.alignPair !== false) {
      const wantRole = msg.role === 'user' ? 'assistant' : 'user';
      const pair = msg.role === 'user' ? conv.messages[at + 1] : conv.messages[at - 1];
      if (pair && pair.role === wantRole) {
        ensureVariants(pair);
        // 成对的那条若没有这个版本号，就保持原样，不强行对齐
        if (i < pair.variants.length) {
          pair.activeVariant = i;
          syncActiveVariant(pair);
          changed.push(pair);
        }
      }
    }
    conv.updatedAt = nowISO();
    this.save();
    return { message: msg, variantIndex: i, changed };
  }

  deleteMessage(conversationId, messageId) {
    const conv = this.getConversation(conversationId);
    if (!conv) return false;
    conv.messages = conv.messages.filter((m) => m.id !== messageId);
    conv.updatedAt = nowISO();
    this.save();
    return true;
  }

  // ---------- attachments ----------
  saveAttachmentFromBuffer(name, mime, buffer) {
    const ext = path.extname(name || '').toLowerCase();
    const id = uid();
    const stored = path.join(this.filesDir, id + ext);
    fs.writeFileSync(stored, buffer);
    return { id, storedPath: stored, name, mime, size: buffer.length, ext };
  }

  attachmentPath(id) {
    try {
      const files = fs.readdirSync(this.filesDir);
      const hit = files.find((f) => f.startsWith(id + '.') || f === id);
      return hit ? path.join(this.filesDir, hit) : null;
    } catch {
      return null;
    }
  }

  readTextAttachment(att) {
    if (!att || !att.path) return '';
    try {
      const buf = fs.readFileSync(att.path);
      return buf.toString('utf8').slice(0, MAX_TEXT_CHARS);
    } catch {
      return '';
    }
  }

  // ---------- 备份 / 恢复 ----------

  /** 把当前 data.json 另存一份（导入前先留退路），返回备份路径 */
  backupCurrentFile() {
    this.saveNow();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = this.file + '.bak-' + stamp;
    try {
      fs.copyFileSync(this.file, target);
      return target;
    } catch (err) {
      console.error('[store] 备份当前数据失败:', err);
      return null;
    }
  }

  /** 用备份内容整体替换（settings 做合并，其余覆盖） */
  importState(data) {
    const base = defaultState();
    this.state = {
      ...base,
      settings: { ...base.settings, ...(this.state.settings || {}), ...(data.settings || {}) },
      connections: Array.isArray(data.connections) ? data.connections : [],
      activeConnectionId: data.activeConnectionId
        || (Array.isArray(data.connections) && data.connections[0] ? data.connections[0].id : null),
      conversations: Array.isArray(data.conversations) ? data.conversations : [],
    };
    this.saveNow();
    return {
      connections: this.state.connections.length,
      conversations: this.state.conversations.length,
      messages: this.state.conversations.reduce((n, c) => n + ((c.messages || []).length), 0),
    };
  }
}

module.exports = {
  Store,
  uid,
  nowISO,
  defaultState,
  summarize,
  MAX_TEXT_CHARS,
  makeVariant,
  ensureVariants,
  activeVariant,
  syncActiveVariant,
};
