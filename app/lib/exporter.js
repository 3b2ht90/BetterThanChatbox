'use strict';

// 对话导出 / 备份 / 导入。
// 这里全是纯函数（不碰 electron，只在 write* 和 read* 那几个函数里碰 fs），方便直接写单元测试。

const fs = require('fs');
const crypto = require('crypto');

const newId = () => crypto.randomUUID();

const KIND_LABEL = {
  image: '图片',
  text: '文本',
  pdf: 'PDF',
  office: 'Office 文档',
  other: '文件',
};

const ROLE_LABEL = { user: '👤 用户', assistant: '🤖 AI' };

function pad(n) {
  return String(n).padStart(2, '0');
}

/** ISO 时间 → 本地时间字符串 */
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 文件名里不能出现的字符换成下划线，并限制长度 */
function safeFileName(name, fallback = '对话') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned || fallback;
}

function humanSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function attachmentLine(att) {
  const kind = KIND_LABEL[att.kind] || '文件';
  let note = '';
  if (att.kind === 'image') note = '，以图片形式发给 AI';
  else if (att.kind === 'text' || att.kind === 'pdf' || att.kind === 'office') {
    note = att.hasText ? '，内容已发送给 AI' : '，未能提取文字（只发了文件名）';
  } else note = '，只发了文件名';
  return `- ${kind}：\`${att.name}\`（${humanSize(att.size)}${note}）`;
}

/**
 * 单个对话 → Markdown
 * @param {object} conv 对话对象
 * @param {object} ctx  { connectionName, connectionType, appVersion }
 */
function conversationToMarkdown(conv, ctx = {}) {
  const lines = [];
  const msgs = conv.messages || [];

  lines.push('# ' + (conv.title || '未命名对话'));
  lines.push('');
  lines.push('- 导出时间：' + fmtTime(new Date().toISOString()));
  lines.push('- 软件：BetterThanChatbox' + (ctx.appVersion ? ' ' + ctx.appVersion : ''));
  if (ctx.connectionName) {
    lines.push('- 接口：' + ctx.connectionName + (ctx.connectionType ? '（' + ctx.connectionType + '）' : ''));
  }
  lines.push('- 模型：' + (conv.model || (ctx.defaultModel ? ctx.defaultModel + '（接口默认）' : '接口默认')));
  lines.push('- 消息数：' + msgs.length);
  if (typeof conv.temperature === 'number') lines.push('- 温度：' + conv.temperature);
  if (conv.systemPrompt) {
    lines.push('- 系统提示词：' + conv.systemPrompt.replace(/\n/g, ' '));
  }
  lines.push('');
  lines.push('---');

  if (!msgs.length) {
    lines.push('');
    lines.push('*（这个对话还没有消息）*');
    return lines.join('\n') + '\n';
  }

  for (const msg of msgs) {
    lines.push('');
    lines.push('## ' + (ROLE_LABEL[msg.role] || msg.role));
    lines.push('');
    if (msg.createdAt) {
      lines.push('*' + fmtTime(msg.createdAt) + '*');
      lines.push('');
    }

    const variants = Array.isArray(msg.variants) ? msg.variants : null;
    if (variants && variants.length > 1) {
      const active = typeof msg.activeVariant === 'number' ? msg.activeVariant : 0;
      lines.push(`> 该条消息有 ${variants.length} 个版本，下面导出的是当前选中的第 ${active + 1} 版。`);
      lines.push('');
    }

    if (msg.attachments && msg.attachments.length) {
      lines.push('附件：');
      lines.push('');
      for (const att of msg.attachments) lines.push(attachmentLine(att));
      lines.push('');
    }

    if (msg.reasoning) {
      lines.push('<details><summary>思考过程</summary>');
      lines.push('');
      lines.push(msg.reasoning);
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }

    if (msg.content) {
      lines.push(msg.content);
    } else if (!msg.attachments || !msg.attachments.length) {
      lines.push('*（空消息）*');
    }

    if (msg.error) {
      lines.push('');
      lines.push('> ⚠️ 出错：' + String(msg.error).replace(/\n/g, ' '));
    }

    lines.push('');
    lines.push('---');
  }

  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n') + '\n';
}

/** 单个对话 → JSON（保留变体等全部字段，便于以后导入） */
function conversationToJson(conv, ctx = {}) {
  return {
    type: 'better-than-chatbox-conversation',
    formatVersion: 1,
    app: 'BetterThanChatbox',
    appVersion: ctx.appVersion || '',
    exportedAt: new Date().toISOString(),
    connectionName: ctx.connectionName || '',
    conversation: conv,
  };
}

/** 全部数据 → 备份对象（含接口配置，所以外面要提醒用户这是敏感文件） */
function backupObject(state, appVersion) {
  return {
    type: 'better-than-chatbox-backup',
    formatVersion: 1,
    app: 'BetterThanChatbox',
    appVersion: appVersion || '',
    exportedAt: new Date().toISOString(),
    counts: {
      connections: (state.connections || []).length,
      conversations: (state.conversations || []).length,
      messages: (state.conversations || []).reduce((n, c) => n + (c.messages || []).length, 0),
    },
    settings: state.settings || {},
    activeConnectionId: state.activeConnectionId || null,
    connections: state.connections || [],
    conversations: state.conversations || [],
  };
}

/**
 * 校验并解析备份文件内容。
 * @returns {{ok:true, data:object} | {ok:false, error:string}}
 */
function parseBackup(text) {
  let json;
  try {
    // 同样要防 BOM：用户可能用记事本另存过备份文件
    const raw = String(text).charCodeAt(0) === 0xfeff ? String(text).slice(1) : String(text);
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: '不是合法的 JSON 文件：' + err.message };
  }
  if (!json || typeof json !== 'object') return { ok: false, error: '文件内容不是一个对象' };
  if (json.type !== 'better-than-chatbox-backup') {
    return {
      ok: false,
      error: '这不是本软件导出的备份文件（type = ' + JSON.stringify(json.type) + '）',
    };
  }
  if (!Array.isArray(json.conversations) || !Array.isArray(json.connections)) {
    return { ok: false, error: '备份文件缺少 connections / conversations 字段' };
  }
  if (json.formatVersion > 1) {
    return { ok: false, error: '备份文件版本（' + json.formatVersion + '）比当前软件更新，无法导入' };
  }
  return { ok: true, data: json };
}

/**
 * 按扩展名决定格式，把对话写进文件。
 * 抽成独立函数是为了能直接单测「内容 + 落盘」这一段，主进程那边只剩弹保存对话框。
 * @returns {{format:'markdown'|'json', bytes:number, path:string}}
 */
function writeConversationFile(filePath, conv, ctx = {}) {
  const ext = String(filePath).slice(String(filePath).lastIndexOf('.')).toLowerCase();
  const isJson = ext === '.json';
  const content = isJson
    ? JSON.stringify(conversationToJson(conv, ctx), null, 2)
    : conversationToMarkdown(conv, ctx);
  fs.writeFileSync(filePath, content, 'utf8');
  return { format: isJson ? 'json' : 'markdown', bytes: Buffer.byteLength(content, 'utf8'), path: filePath };
}

/** 把整库备份写进文件 */
function writeBackupFile(filePath, state, appVersion) {
  const backup = backupObject(state, appVersion);
  const content = JSON.stringify(backup, null, 2);
  fs.writeFileSync(filePath, content, 'utf8');
  return {
    format: 'json',
    bytes: Buffer.byteLength(content, 'utf8'),
    path: filePath,
    counts: backup.counts,
  };
}

/**
 * 导入：把「导出的 JSON」或「整库备份」解析成一串可直接落库的对话。
 * 只认本软件导出的结构；数量与内容都做校验，坏文件给出人能看懂的报错。
 *
 * @param {string} text 文件内容
 * @param {{exists?: (p:string)=>boolean, from?: string}} opts
 *        exists 用来判断附件原文件在不在这台机器上（便于单测注入）
 * @returns {{ok:true, kind:'conversation'|'backup', conversations:Array, count:number} | {ok:false, error:string}}
 */
function parseImportFile(text, opts = {}) {
  const exists = opts.exists || (() => false);
  let json;
  try {
    const raw = String(text).charCodeAt(0) === 0xfeff ? String(text).slice(1) : String(text);
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: '不是合法的 JSON：' + err.message };
  }
  if (!json || typeof json !== 'object') return { ok: false, error: '文件内容不是一个对象' };

  let rawList = [];
  let kind = 'conversation';
  if (json.type === 'better-than-chatbox-conversation') {
    if (!json.conversation || typeof json.conversation !== 'object') {
      return { ok: false, error: '这个对话文件里没有 conversation 字段' };
    }
    rawList = [json.conversation];
  } else if (json.type === 'better-than-chatbox-backup') {
    if (!Array.isArray(json.conversations)) return { ok: false, error: '备份文件缺少 conversations 字段' };
    if (json.formatVersion > 1) {
      return { ok: false, error: '备份文件版本（' + json.formatVersion + '）比当前软件更新，无法导入' };
    }
    rawList = json.conversations;
    kind = 'backup';
  } else if (Array.isArray(json.messages)) {
    // 有人可能直接把对话对象存了出来，宽容一点也认
    rawList = [json];
  } else {
    return {
      ok: false,
      error: '这不是本软件导出的对话或备份文件（type = ' + JSON.stringify(json.type) + '）',
    };
  }

  if (!rawList.length) return { ok: false, error: '文件里没有任何对话' };
  const conversations = rawList
    .filter((c) => c && typeof c === 'object')
    .map((c) => normalizeImportedConversation(c, { exists, from: opts.from }));
  if (!conversations.length) return { ok: false, error: '文件里的对话都是空的' };

  return { ok: true, kind, conversations, count: conversations.length };
}

/** 单个对话对象 → 可直接落库的新对话（换新 id、修附件、补字段） */
function normalizeImportedConversation(raw, opts = {}) {
  const exists = opts.exists || (() => false);
  const now = new Date().toISOString();

  const messages = (Array.isArray(raw.messages) ? raw.messages : []).map((m) => {
    const msg = {
      id: newId(),
      role: m && m.role === 'assistant' ? 'assistant' : 'user',
      content: String((m && m.content) || ''),
      reasoning: String((m && m.reasoning) || ''),
      attachments: (Array.isArray(m && m.attachments) ? m.attachments : []).map((a) => fixImportedAttachment(a, exists)),
      error: (m && m.error) || null,
      createdAt: (m && m.createdAt) || now,
    };
    if (m && Array.isArray(m.variants) && m.variants.length) {
      msg.variants = m.variants.map((v) => ({
        content: String((v && v.content) || ''),
        reasoning: String((v && v.reasoning) || ''),
        error: (v && v.error) || null,
        createdAt: (v && v.createdAt) || now,
      }));
      const idx = Number(m.activeVariant) || 0;
      msg.activeVariant = Math.min(Math.max(idx, 0), msg.variants.length - 1);
    }
    return msg;
  });

  const conv = {
    id: newId(),
    title: String(raw.title || '导入的对话').slice(0, 80),
    createdAt: raw.createdAt || now,
    updatedAt: now,
    connectionId: null, // 导入的对话不绑接口：那是别人机器上的配置，让用户自己选
    model: String(raw.model || ''),
    systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : '',
    messages,
    importedAt: now,
    importedFrom: opts.from || '',
  };
  if (typeof raw.temperature === 'number') conv.temperature = raw.temperature;
  return conv;
}

/** 附件：原文件在这台机器上就保留，不在就标 missing（正文还能用，图片显示占位） */
function fixImportedAttachment(a, exists) {
  const src = a && typeof a === 'object' ? a : {};
  const copy = { ...src };
  copy.id = newId();
  if (!copy.kind) copy.kind = 'other';
  copy.name = String(copy.name || '未命名文件');
  copy.hasText = Boolean(copy.text);
  if (copy.path && !exists(copy.path)) {
    copy.missing = true;
    delete copy.url;
  }
  return copy;
}

/**
 * 导入 Markdown：只认本软件导出的那种结构（`## 👤 用户` / `## 🤖 AI` 分段）。
 * 认不出来就当一整段文本，塞成一条消息 —— 不会失败，也不会乱猜。
 * @returns {{ok:true, kind:'markdown', conversations:Array, count:number, parsed:boolean}}
 */
function parseImportMarkdown(text, opts = {}) {
  const src = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const now = new Date().toISOString();
  const titleMatch = /^#\s+(.+)$/m.exec(src);
  const title = (titleMatch ? titleMatch[1].trim() : '').slice(0, 80) || '导入的对话';

  const headerRe = /^##\s+(👤\s*用户|🤖\s*AI)\s*$/gm;
  const marks = [];
  let m;
  while ((m = headerRe.exec(src)) !== null) {
    marks.push({ role: m[1].includes('AI') ? 'assistant' : 'user', start: m.index, bodyStart: m.index + m[0].length });
  }

  const messages = [];
  if (marks.length) {
    for (let i = 0; i < marks.length; i++) {
      const cur = marks[i];
      const end = i + 1 < marks.length ? marks[i + 1].start : src.length;
      let body = src.slice(cur.bodyStart, end);
      body = body.replace(/\n?^---\s*$/m, '\n'); // 段尾的分隔线
      const parsed = parseMarkdownSection(body, now);
      messages.push({
        id: newId(),
        role: cur.role,
        content: parsed.content,
        reasoning: parsed.reasoning,
        attachments: parsed.attachments,
        error: null,
        createdAt: parsed.createdAt || now,
      });
    }
  } else {
    // 不是导出的格式：整篇当一条 AI 消息（去掉标题行）
    const body = src.replace(/^#\s+.+$/m, '').trim();
    if (!body) return { ok: false, error: '这个 Markdown 文件里没有内容' };
    messages.push({
      id: newId(), role: 'assistant', content: body, reasoning: '', attachments: [], error: null, createdAt: now,
    });
  }

  if (!messages.length) return { ok: false, error: '没能从这个 Markdown 里解析出任何消息' };
  return {
    ok: true,
    kind: 'markdown',
    parsed: marks.length > 0,
    count: 1,
    conversations: [{
      id: newId(),
      title,
      createdAt: now,
      updatedAt: now,
      connectionId: null,
      model: '',
      systemPrompt: '',
      messages,
      importedAt: now,
      importedFrom: opts.from || '',
    }],
  };
}

/** 解析导出格式里的一段：去掉时间行、附件清单、思考过程折叠块 */
function parseMarkdownSection(body, now) {
  let text = body.trim();
  let createdAt = null;
  let reasoning = '';

  // 顶部的时间行：*2026-09-28 10:06:55*
  const t = /^\*(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\*$/.exec(text.split('\n')[0] || '');
  if (t) {
    const d = new Date(Number(t[1]), Number(t[2]) - 1, Number(t[3]), Number(t[4]), Number(t[5]), Number(t[6]));
    if (!Number.isNaN(d.getTime())) createdAt = d.toISOString();
    text = text.split('\n').slice(1).join('\n').trim();
  }

  // 多版本提示行（导出时加的说明，不是正文）
  text = text.replace(/^>\s*该条消息有 \d+ 个版本[^\n]*\n?/m, '').trim();

  // 思考过程折叠块
  const det = /<details><summary>思考过程<\/summary>([\s\S]*?)<\/details>/.exec(text);
  if (det) {
    reasoning = det[1].trim();
    text = text.replace(det[0], '').trim();
  }

  // 附件清单（导出时是「附件：」开头的一小段）
  const attachments = [];
  const attBlock = /^附件：\s*\n((?:- .*\n?)+)/m.exec(text);
  if (attBlock) {
    for (const line of attBlock[1].split('\n')) {
      const nm = /^-\s*(图片|文本|PDF|Office 文档|文件)：`(.+?)`/.exec(line.trim());
      if (nm) {
        attachments.push({
          id: newId(),
          kind: { 图片: 'image', 文本: 'text', PDF: 'pdf', 'Office 文档': 'office' }[nm[1]] || 'other',
          name: nm[2],
          text: '',
          hasText: false,
          missing: true, // Markdown 里没有原文件，只能留个名字
        });
      }
    }
    text = text.replace(attBlock[0], '').trim();
  }

  return { content: text, reasoning, attachments, createdAt };
}

/** 读一个导入文件并按扩展名/内容选解析器 */
function readImportFile(filePath, opts = {}) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, error: '读不了这个文件：' + err.message };
  }
  const ext = String(filePath).slice(String(filePath).lastIndexOf('.')).toLowerCase();
  const trimmed = text.replace(/^\uFEFF/, '').trimStart();
  // .json 或者内容以 { 开头 → 按 JSON 解析；否则按 Markdown
  if (ext === '.json' || trimmed.startsWith('{')) {
    const res = parseImportFile(text, { ...opts, from: filePath });
    if (!res.ok && ext === '.json') return res;
    if (res.ok) return res;
  }
  return parseImportMarkdown(text, { ...opts, from: filePath });
}

module.exports = {
  conversationToMarkdown,
  conversationToJson,
  backupObject,
  parseBackup,
  parseImportFile,
  parseImportMarkdown,
  normalizeImportedConversation,
  safeFileName,
  fmtTime,
  attachmentLine,
  writeConversationFile,
  writeBackupFile,
  readImportFile,
};
