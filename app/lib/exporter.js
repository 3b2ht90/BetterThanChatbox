'use strict';

// 对话导出 / 备份。
// 这里全是纯函数（不碰 electron，只在下面前两个 write* 里碰 fs），方便直接写单元测试。

const fs = require('fs');

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

module.exports = {
  conversationToMarkdown,
  conversationToJson,
  backupObject,
  parseBackup,
  safeFileName,
  fmtTime,
  attachmentLine,
  writeConversationFile,
  writeBackupFile,
};
