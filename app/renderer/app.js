'use strict';

// 用函数作用域包起来：preload 通过 contextBridge 暴露的 window.api 是不可配置的全局属性，
// 顶层再声明 const api 会直接 SyntaxError（Identifier 'api' has already been declared）。
(function () {

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const api = window.api;

const el = {
  convList: $('#conv-list'),
  messages: $('#messages'),
  input: $('#input'),
  pending: $('#pending'),
  send: $('#btn-send'),
  attach: $('#btn-attach'),
  newBtn: $('#btn-new'),
  settings: $('#btn-settings'),
  title: $('#conv-title'),
  connSelect: $('#conn-select'),
  modelInput: $('#model-input'),
  convParams: $('#btn-conv-params'),
  themeBtn: $('#btn-theme'),
  toast: $('#toast'),
  drop: $('#drop-overlay'),
  modalRoot: $('#modal-root'),
  hint: $('#hint'),
};

let S = { conversations: [], connections: [], settings: {}, activeConnectionId: null, appInfo: {} };
let currentId = null;
let pendingAtts = [];
let streaming = null; // { streamId, conversationId, messageId, text, reasoning, el, bubble, reasonEl, timer }
let toastTimer = null;

// ---------------- 工具 ----------------

function uid() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function toast(msg, isError) {
  el.toast.textContent = msg;
  el.toast.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.className = 'toast' + (isError ? ' error' : ''); }, isError ? 6000 : 2600);
}

function errText(err) {
  return String((err && err.message) || err || '未知错误').replace(/^Error:\s*/, '');
}

const currentConv = () => S.conversations.find((c) => c.id === currentId) || null;
const findConv = (id) => S.conversations.find((c) => c.id === id) || null;
const connOf = (conv) => S.connections.find((c) => c.id === (conv && conv.connectionId)) || null;

// ---------------- 主题 ----------------

const THEME_LABEL = { light: '浅色米白', dark: '深色深绿', system: '跟随系统' };
const THEME_ICON = { light: '☀', dark: '🌙', system: '🌗' };
const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');

function themeSetting() {
  const t = S.settings && S.settings.theme;
  return t === 'light' || t === 'dark' ? t : 'system';
}

// 「跟随系统」时由系统偏好决定，其余情况用用户明确选的
function resolvedTheme() {
  const t = themeSetting();
  if (t !== 'system') return t;
  return themeMedia.matches ? 'dark' : 'light';
}

function paintTheme() {
  const mode = themeSetting();
  document.documentElement.dataset.theme = resolvedTheme();
  if (el.themeBtn) {
    el.themeBtn.textContent = THEME_ICON[mode];
    el.themeBtn.title = '主题：' + THEME_LABEL[mode] + '（点击切换浅色 / 深色）';
  }
}

async function setTheme(value) {
  const theme = value === 'light' || value === 'dark' ? value : 'system';
  S.settings = { ...S.settings, theme };
  paintTheme();
  await api.updateSettings({ theme });
}

function toggleTheme() {
  const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next)
    .then(() => toast('已切换到' + THEME_LABEL[next] + '主题'))
    .catch((err) => toast('切换主题失败：' + errText(err), true));
}

// 系统主题变化时，只有「跟随系统」模式需要跟着变
const onSystemThemeChange = () => { if (themeSetting() === 'system') paintTheme(); };
if (typeof themeMedia.addEventListener === 'function') themeMedia.addEventListener('change', onSystemThemeChange);
else if (typeof themeMedia.addListener === 'function') themeMedia.addListener(onSystemThemeChange);

// ---------------- 启动 ----------------

async function init() {
  S = await api.getState();
  paintTheme();
  if (!S.conversations.length) {
    const conv = await api.createConversation({});
    S.conversations.unshift(conv);
  }
  currentId = S.conversations[0].id;

  bindEvents();
  api.onChatEvent(handleChatEvent);
  api.onMenuAction((payload) => {
    if (!payload) return;
    if (payload.action === 'new-conversation') newConversation();
    if (payload.action === 'open-settings') openSettings('conn');
  });

  renderSidebar();
  renderTopbar();
  await renderMessages();

  // 数据文件读不出来时必须让人知道，不能静默当成空数据
  if (S.readWarning) {
    toast('⚠️ ' + S.readWarning, true);
  }

  if (!S.connections.length) {
    toast('还没有配置接口，先点左下角「设置」添加一个 API 接口', true);
    openSettings('conn');
  }
}

function bindEvents() {
  el.newBtn.addEventListener('click', newConversation);
  el.settings.addEventListener('click', () => openSettings('conn'));
  el.convParams.addEventListener('click', openConvParams);
  el.themeBtn.addEventListener('click', toggleTheme);
  el.send.addEventListener('click', onSendOrStop);
  el.attach.addEventListener('click', pickFiles);

  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      onSendOrStop();
    }
  });
  el.input.addEventListener('input', autoResize);

  el.title.addEventListener('change', () => renameConversation(currentId, el.title.value));
  el.title.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.title.blur(); });

  el.connSelect.addEventListener('change', async () => {
    const conv = currentConv();
    if (!conv) return;
    conv.connectionId = el.connSelect.value;
    await api.updateConversation(conv.id, { connectionId: conv.connectionId });
    const conn = connOf(conv);
    toast('本对话接口已切换为：' + (conn ? conn.name : '未配置'));
  });

  el.modelInput.addEventListener('change', async () => {
    const conv = currentConv();
    if (!conv) return;
    conv.model = el.modelInput.value.trim();
    await api.updateConversation(conv.id, { model: conv.model });
  });

  el.messages.addEventListener('click', onMessageClick);
  el.pending.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    pendingAtts = pendingAtts.filter((a) => a.id !== btn.dataset.remove);
    renderPending();
  });

  document.addEventListener('paste', onPaste);
  window.addEventListener('dragover', (e) => { e.preventDefault(); el.drop.classList.remove('hidden'); });
  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null || e.clientX <= 0 || e.clientY <= 0) el.drop.classList.add('hidden');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    el.drop.classList.add('hidden');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
}

// ---------------- 侧栏 ----------------

function renderSidebar() {
  el.convList.innerHTML = '';
  for (const conv of S.conversations) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (conv.id === currentId ? ' active' : '');
    item.dataset.id = conv.id;

    const spin = streaming && streaming.conversationId === conv.id
      ? '<span class="conv-spin" title="生成中"></span>' : '';

    item.innerHTML =
      spin +
      '<span class="conv-name" title="' + esc(conv.title) + '">' + esc(conv.title || '新对话') + '</span>' +
      '<span class="conv-tools">' +
      '<button data-act="export" title="导出这个对话">⬇</button>' +
      '<button data-act="rename" title="重命名">✏️</button>' +
      '<button data-act="delete" class="danger" title="删除对话">🗑</button>' +
      '</span>';

    item.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (btn) {
        e.stopPropagation();
        if (btn.dataset.act === 'export') exportConversation(conv.id);
        if (btn.dataset.act === 'rename') startRename(item, conv);
        if (btn.dataset.act === 'delete') deleteConversation(conv.id);
        return;
      }
      switchConversation(conv.id);
    });

    el.convList.appendChild(item);
  }
}

function startRename(item, conv) {
  const nameEl = $('.conv-name', item);
  nameEl.innerHTML = '<input type="text" value="' + esc(conv.title) + '" />';
  const input = $('input', nameEl);
  input.focus();
  input.select();
  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (save && value) await renameConversation(conv.id, value);
    else renderSidebar();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit(true);
    if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

async function renameConversation(id, title) {
  const conv = findConv(id);
  if (!conv) return;
  const value = String(title || '').trim() || '新对话';
  if (value === conv.title) { renderSidebar(); return; }
  conv.title = value;
  await api.updateConversation(id, { title: value });
  renderSidebar();
  if (id === currentId) el.title.value = value;
}

async function newConversation() {
  const conv = await api.createConversation({
    connectionId: S.activeConnectionId,
    systemPrompt: S.settings.defaultSystemPrompt,
    temperature: S.settings.defaultTemperature,
  });
  S.conversations.unshift(conv);
  currentId = conv.id;
  renderSidebar();
  renderTopbar();
  await renderMessages();
  el.input.focus();
}

async function deleteConversation(id) {
  const conv = findConv(id);
  if (!conv) return;
  if (!window.confirm(`确定删除对话「${conv.title}」？此操作不可撤销。`)) return;
  if (streaming && streaming.conversationId === id) {
    await api.stopChat(streaming.streamId).catch(() => {});
    streaming = null;
    updateSendButton();
  }
  await api.deleteConversation(id);
  S.conversations = S.conversations.filter((c) => c.id !== id);
  if (!S.conversations.length) {
    const fresh = await api.createConversation({});
    S.conversations.unshift(fresh);
  }
  if (currentId === id) currentId = S.conversations[0].id;
  renderSidebar();
  renderTopbar();
  await renderMessages();
  toast('对话已删除');
}

// ---------------- 导出 / 备份 ----------------

async function exportConversation(id) {
  const conv = findConv(id);
  if (!conv) return;
  try {
    const res = await api.exportConversation(id);
    if (res.canceled) return;
    toast(`已导出 ${res.messages} 条消息到：${res.path}`);
  } catch (err) {
    toast('导出失败：' + errText(err), true);
  }
}

async function backupAllData() {
  try {
    const res = await api.backupAll();
    if (res.canceled) return;
    toast(`已备份 ${res.counts.connections} 个接口、${res.counts.conversations} 个对话、` +
      `${res.counts.messages} 条消息到：${res.path}`);
  } catch (err) {
    toast('备份失败：' + errText(err), true);
  }
}

async function restoreAllData() {
  try {
    const res = await api.restoreAll();
    if (res.canceled) return;
    toast(`已导入 ${res.counts.connections} 个接口、${res.counts.conversations} 个对话，` +
      '重启软件后完全生效');
    S = await api.getState();
    currentId = S.conversations.length ? S.conversations[0].id : null;
    closeModal();
    renderSidebar();
    renderTopbar();
    await renderMessages();
  } catch (err) {
    toast('导入失败：' + errText(err), true);
  }
}

async function switchConversation(id) {  if (id === currentId) return;
  currentId = id;
  pendingAtts = [];
  renderPending();
  renderSidebar();
  renderTopbar();
  await renderMessages();
  el.input.focus();
}

// ---------------- 顶栏 ----------------

function renderTopbar() {
  const conv = currentConv();
  if (!conv) return;
  el.title.value = conv.title || '';
  el.modelInput.value = conv.model || '';

  el.connSelect.innerHTML = '';
  if (!S.connections.length) {
    const opt = document.createElement('option');
    opt.textContent = '（未配置接口）';
    opt.value = '';
    el.connSelect.appendChild(opt);
  } else {
    for (const conn of S.connections) {
      const opt = document.createElement('option');
      opt.value = conn.id;
      opt.textContent = conn.name + ' · ' + typeLabel(conn.type);
      if (conn.id === conv.connectionId) opt.selected = true;
      el.connSelect.appendChild(opt);
    }
    if (!conv.connectionId) el.connSelect.value = S.connections[0].id;
  }
  updateHint();
}

function typeLabel(t) {
  return t === 'anthropic' ? 'Claude' : t === 'gemini' ? 'Gemini' : 'OpenAI 兼容';
}

function updateHint() {
  const conv = currentConv();
  const conn = connOf(conv);
  if (!conn) { el.hint.textContent = '未配置接口'; return; }
  const model = (conv && conv.model) || conn.model || '（默认模型）';
  el.hint.textContent = conn.name + ' · ' + model;
}

// ---------------- 消息渲染 ----------------

function attachmentHtml(att, opts = {}) {
  if (att.kind === 'image') {
    return '<div class="att-thumb" data-open="' + esc(att.path) + '" title="' + esc(att.name + ' · ' + fmtSize(att.size)) + '">' +
      '<img src="' + esc(att.url) + '" alt="' + esc(att.name) + '"></div>';
  }
  const warn = att.kind === 'other' || ((att.kind === 'pdf' || att.kind === 'office') && !att.hasText);
  const icon = att.kind === 'pdf' ? '📕'
    : att.kind === 'office' ? (att.ext === '.xlsx' ? '📊' : att.ext === '.pptx' ? '📽' : '📘')
      : att.kind === 'text' ? '📄' : '📦';
  const warnText = att.kind === 'office'
    ? '（文档里没有提取到文字，仅发送文件名）'
    : '（该格式无法解析为文字，仅发送文件名）';
  return '<div class="att clickable' + (warn ? ' warn' : '') + '" data-open="' + esc(att.path) + '" title="' +
    esc(warn ? att.name + warnText : att.name) + '">' +
    '<span>' + icon + '</span>' +
    '<span class="att-name">' + esc(att.name) + '</span>' +
    '<span class="att-size">' + esc(fmtSize(att.size)) + '</span>' +
    (opts.removable ? '<button class="att-x" data-remove="' + esc(att.id) + '" title="移除">✕</button>' : '') +
    '</div>';
}

// 版本切换器：这条消息有多个版本（重新回答 / 编辑提问产生的分支）时才出现
function variantBarHtml(msg) {
  const total = Array.isArray(msg.variants) ? msg.variants.length : 1;
  if (total < 2) return '';
  const cur = Math.min(Math.max(Number(msg.activeVariant) || 0, 0), total - 1) + 1;
  return '<span class="variant-bar">' +
    '<button data-act="var-prev" title="上一个版本">‹</button>' +
    '<span class="variant-pos">' + cur + '/' + total + '</span>' +
    '<button data-act="var-next" title="下一个版本">›</button>' +
    '</span>';
}

async function buildMessageEl(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (msg.role === 'user' ? 'msg-user' : 'msg-assistant') + (msg.error ? ' msg-error' : '');
  wrap.dataset.id = msg.id;

  const head = document.createElement('div');
  head.className = 'msg-head';
  head.innerHTML = '<span>' + (msg.role === 'user' ? '你' : 'AI') + '</span>' + variantBarHtml(msg);
  wrap.appendChild(head);

  if (msg.attachments && msg.attachments.length) {
    const atts = document.createElement('div');
    atts.className = 'atts';
    atts.innerHTML = msg.attachments.map((a) => attachmentHtml(a)).join('');
    wrap.appendChild(atts);
  }

  if (msg.reasoning) {
    const r = document.createElement('div');
    r.className = 'reasoning';
    r.textContent = msg.reasoning;
    wrap.appendChild(r);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (msg.content) {
    bubble.innerHTML = await api.renderMarkdown(msg.content);
  }
  wrap.appendChild(bubble);

  const tools = document.createElement('div');
  tools.className = 'msg-tools';
  tools.innerHTML =
    '<button data-act="copy">复制</button>' +
    (msg.role === 'assistant' ? '<button data-act="retry" title="再问一次，旧回答会留作历史版本">重新回答</button>' : '') +
    (msg.role === 'user' ? '<button data-act="edit" title="改完会开一条新分支，旧提问保留">编辑</button>' : '') +
    '<button data-act="del">删除</button>';
  wrap.appendChild(tools);

  return wrap;
}

async function renderMessages() {
  el.messages.innerHTML = '';
  const conv = currentConv();
  if (!conv) return;
  if (!conv.messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<h2>开始新的对话</h2><div>在下面输入内容，或把图片 / 文件拖进窗口</div>' +
      '<div style="margin-top:8px;font-size:12.5px">当前接口：' +
      esc(connOf(conv) ? connOf(conv).name : '未配置（点左下角设置）') + '</div>';
    el.messages.appendChild(empty);
    return;
  }
  for (const msg of conv.messages) {
    el.messages.appendChild(await buildMessageEl(msg));
  }
  scrollToBottom(false);
}

function scrollToBottom(smooth) {
  el.messages.scrollTo({ top: el.messages.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function nearBottom() {
  return el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 140;
}

async function onMessageClick(e) {
  const openEl = e.target.closest('[data-open]');
  if (openEl) {
    const p = openEl.dataset.open;
    if (p) api.openAttachment(p);
    return;
  }
  const copyCode = e.target.closest('[data-copy]');
  if (copyCode) {
    const block = copyCode.closest('.code-block');
    const code = block ? $('code', block) : null;
    if (code) {
      await navigator.clipboard.writeText(code.innerText);
      copyCode.textContent = '已复制';
      setTimeout(() => { copyCode.textContent = '复制'; }, 1200);
    }
    return;
  }
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const msgEl = btn.closest('.msg');
  const conv = currentConv();
  if (!conv || !msgEl) return;
  const msg = conv.messages.find((m) => m.id === msgEl.dataset.id);
  if (!msg) return;

  if (btn.dataset.act === 'copy') {
    await navigator.clipboard.writeText(msg.content || '');
    toast('已复制到剪贴板');
  } else if (btn.dataset.act === 'del') {
    await api.deleteMessage(conv.id, msg.id);
    conv.messages = conv.messages.filter((m) => m.id !== msg.id);
    msgEl.remove();
    if (!conv.messages.length) renderMessages();
  } else if (btn.dataset.act === 'retry') {
    // 重新回答：不删旧回答，改成给它追加一个新版本
    if (streaming) { toast('正在生成中，请先停止', true); return; }
    startStream({ reanswerOf: msg.id });
  } else if (btn.dataset.act === 'var-prev' || btn.dataset.act === 'var-next') {
    // 生成中不能切：正在流式写入的版本会跟着 activeVariant 走，切了会把内容写错版本
    if (streaming) { toast('正在生成中，请先停止', true); return; }
    const total = (msg.variants || []).length;
    if (total < 2) return;
    const cur = Math.min(Math.max(Number(msg.activeVariant) || 0, 0), total - 1);
    const delta = btn.dataset.act === 'var-next' ? 1 : total - 1;
    await switchVariant(conv, msg.id, (cur + delta) % total);
  } else if (btn.dataset.act === 'edit') {
    startEditMessage(conv, msg, msgEl);
  } else if (btn.dataset.act === 'edit-cancel') {
    cancelEditMessage(msgEl);
  } else if (btn.dataset.act === 'edit-save') {
    await saveEditMessage(conv, msg, msgEl);
  }
}

// ---------------- 重新回答 / 对话分支 ----------------

// 切换版本：主进程会顺带把「提问 / 回答」成对的那条对齐到同一版本号
async function switchVariant(conv, messageId, index) {
  const res = await api.setVariant(conv.id, messageId, index).catch((err) => {
    toast('切换版本失败：' + errText(err), true);
    return null;
  });
  if (!res || !Array.isArray(res.changed)) return;
  for (const m of res.changed) {
    const local = conv.messages.find((x) => x.id === m.id);
    if (local) Object.assign(local, m);
  }
  for (const m of res.changed) await rebuildMessageEl(conv, m.id);
}

async function rebuildMessageEl(conv, messageId) {
  const local = conv.messages.find((x) => x.id === messageId);
  const old = el.messages.querySelector('.msg[data-id="' + messageId + '"]');
  if (!local || !old) return;
  const fresh = await buildMessageEl(local);
  old.replaceWith(fresh);
}

// 编辑提问：气泡就地变输入框；保存后旧提问留作历史版本，并给紧随其后的回答开新分支
function startEditMessage(conv, msg, msgEl) {
  if (streaming) { toast('正在生成中，请先停止', true); return; }
  if (msgEl.querySelector('.edit-box')) return;
  const bubble = $('.bubble', msgEl);
  if (!bubble) return;
  bubble.classList.add('hidden');
  const box = document.createElement('div');
  box.className = 'edit-box';
  box.innerHTML =
    '<textarea class="edit-input" rows="1"></textarea>' +
    '<div class="edit-actions">' +
    '<button class="primary-btn" data-act="edit-save">保存并重新回答</button>' +
    '<button class="ghost-btn" data-act="edit-cancel">取消</button>' +
    '<span class="edit-hint">Enter 保存 · Shift+Enter 换行 · Esc 取消；旧提问会留作历史版本</span>' +
    '</div>';
  bubble.after(box);
  const ta = $('.edit-input', box);
  ta.value = msg.content || '';
  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 320) + 'px';
  };
  autosize();
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEditMessage(msgEl);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEditMessage(conv, msg, msgEl);
    }
  });
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function cancelEditMessage(msgEl) {
  const box = $('.edit-box', msgEl);
  if (box) box.remove();
  const bubble = $('.bubble', msgEl);
  if (bubble) bubble.classList.remove('hidden');
}

async function saveEditMessage(conv, msg, msgEl) {
  const box = $('.edit-box', msgEl);
  if (!box) return;
  const text = $('.edit-input', box).value.trim();
  if (!text) { toast('内容不能为空', true); return; }
  if (text === (msg.content || '').trim()) { toast('内容没有变化'); cancelEditMessage(msgEl); return; }
  if (streaming) { toast('正在生成中，请先停止', true); return; }

  const saveBtn = $('[data-act="edit-save"]', box);
  if (saveBtn) saveBtn.disabled = true;
  const res = await api.editMessageBranch(conv.id, msg.id, { content: text }).catch((err) => {
    toast('保存失败：' + errText(err), true);
    return null;
  });
  if (!res) {
    if (saveBtn) saveBtn.disabled = false;
    return;
  }
  const local = conv.messages.find((x) => x.id === msg.id);
  if (local) Object.assign(local, res.message);
  if (res.title) {
    conv.title = res.title;
    if (conv.id === currentId) el.title.value = res.title;
    renderSidebar();
  }
  await rebuildMessageEl(conv, msg.id);

  // 提问换了，紧随其后的回答也开一条新分支；后面没有回答就正常发一条
  const at = conv.messages.findIndex((x) => x.id === msg.id);
  const next = conv.messages[at + 1];
  if (next && next.role === 'assistant') startStream({ reanswerOf: next.id });
  else startStream();
}

// ---------------- 附件 ----------------

async function pickFiles() {
  try {
    const metas = await api.pickFiles();
    for (const meta of metas) {
      if (meta && meta.error) { toast('添加失败：' + meta.name + ' — ' + meta.error, true); continue; }
      pendingAtts.push(meta);
    }
    renderPending();
  } catch (err) {
    toast('选择文件失败：' + errText(err), true);
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      const idx = s.indexOf(',');
      resolve(idx >= 0 ? s.slice(idx + 1) : '');
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    if (file.size > 30 * 1024 * 1024) { toast('文件过大（上限 30 MB）：' + file.name, true); continue; }
    try {
      const base64 = await fileToBase64(file);
      const meta = await api.saveAttachment({ name: file.name || 'clipboard.png', mime: file.type || '', base64 });
      pendingAtts.push(meta);
    } catch (err) {
      toast('添加失败：' + errText(err), true);
    }
  }
  renderPending();
}

async function onPaste(e) {
  const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
  const files = items.filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  await addFiles(files);
}

function renderPending() {
  if (!pendingAtts.length) {
    el.pending.classList.add('hidden');
    el.pending.innerHTML = '';
    return;
  }
  el.pending.classList.remove('hidden');
  el.pending.innerHTML = pendingAtts.map((a) => attachmentHtml(a, { removable: true })).join('');
}

// ---------------- 发送 / 流式 ----------------

function autoResize() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 260) + 'px';
}

function updateSendButton() {
  if (streaming) {
    el.send.textContent = '⏹ 停止';
    el.send.classList.add('danger-btn');
    el.send.classList.remove('primary-btn');
  } else {
    el.send.textContent = '发送';
    el.send.classList.remove('danger-btn');
    el.send.classList.add('primary-btn');
  }
}

async function onSendOrStop() {
  if (streaming) {
    await api.stopChat(streaming.streamId).catch(() => {});
    return;
  }
  await sendMessage();
}

async function sendMessage() {
  const conv = currentConv();
  if (!conv) return;
  const text = el.input.value.trim();
  if (!text && !pendingAtts.length) return;
  if (!convOfConnReady(conv)) return;

  const msg = await api.appendMessage(conv.id, {
    role: 'user',
    content: text,
    attachments: pendingAtts.slice(),
  });
  conv.messages.push(msg);

  pendingAtts = [];
  renderPending();
  el.input.value = '';
  autoResize();

  if (conv.messages.length === 1) el.messages.innerHTML = '';
  el.messages.appendChild(await buildMessageEl(msg));
  scrollToBottom(true);
  renderSidebar();

  startStream();
}

function convOfConnReady(conv) {
  const conn = connOf(conv) || S.connections.find((c) => c.id === S.activeConnectionId);
  if (!conn) {
    toast('还没有配置接口，请先在「设置」里添加', true);
    openSettings('conn');
    return false;
  }
  if (!conv.connectionId) {
    conv.connectionId = conn.id;
    api.updateConversation(conv.id, { connectionId: conn.id });
    renderTopbar();
  }
  return true;
}

// target.reanswerOf 有值 = 对那条回答重新回答（追加新版本）；不传 = 正常新建一条回答
async function startStream(target) {
  const conv = currentConv();
  if (!conv || streaming) return;
  const reanswerOf = (target && target.reanswerOf) || null;
  streaming = {
    streamId: uid(),
    conversationId: conv.id,
    messageId: null,
    variantIndex: null,
    reanswerOf,
    text: '',
    reasoning: '',
    el: null,
    bubble: null,
    reasonEl: null,
    timer: null,
    pendingRender: false,
  };
  updateSendButton();
  renderSidebar();
  try {
    if (reanswerOf) await api.reanswerChat(conv.id, streaming.streamId, reanswerOf);
    else await api.sendChat(conv.id, streaming.streamId);
  } catch (err) {
    streaming = null;
    updateSendButton();
    renderSidebar();
    toast((reanswerOf ? '重新回答失败：' : '发送失败：') + errText(err), true);
  }
}

// 同步创建流式占位元素（不能是 async：否则 start 事件处理会让出微任务，
// 后续 delta 可能在 st.bubble 还没赋值时被调度，导致首段文本丢失）
function ensureAssistantEl(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';
  wrap.dataset.id = msg.id;
  wrap.innerHTML =
    '<div class="msg-head"><span>AI</span>' + variantBarHtml(msg) + '</div>' +
    '<div class="reasoning hidden"></div>' +
    '<div class="bubble"><span class="cursor-blink"></span></div>' +
    '<div class="msg-tools">' +
    '<button data-act="copy">复制</button><button data-act="retry">重新回答</button><button data-act="del">删除</button>' +
    '</div>';
  // 重新回答时这条消息本来就在：就地替换，既不能追加到列表末尾，也不能清空列表
  const existing = el.messages.querySelector('.msg[data-id="' + msg.id + '"]');
  if (existing) {
    existing.replaceWith(wrap);
  } else {
    if (currentConv() && currentConv().messages.length <= 1) el.messages.innerHTML = '';
    el.messages.appendChild(wrap);
  }
  scrollToBottom(true);
  return wrap;
}

function scheduleRender(st) {
  if (st.timer) return;
  st.timer = setTimeout(async () => {
    st.timer = null;
    if (st.conversationId !== currentId) return;
    if (!st.bubble) {
      // 占位元素还没建好（极少见）：稍后重试，别把已收到的文本丢掉
      scheduleRender(st);
      return;
    }
    const stick = nearBottom();
    let html;
    if (st.text.length > 60000) {
      html = '<p style="white-space:pre-wrap">' + esc(st.text) + '</p>';
    } else {
      html = await api.renderMarkdown(st.text);
    }
    st.bubble.innerHTML = html + '<span class="cursor-blink"></span>';
    if (stick) scrollToBottom(false);
  }, 90);
}

async function handleChatEvent(ev) {
  if (!streaming || ev.streamId !== streaming.streamId) return;
  const st = streaming;
  const conv = findConv(ev.conversationId);

  if (ev.type === 'start') {
    st.messageId = ev.messageId;
    st.variantIndex = typeof ev.variantIndex === 'number' ? ev.variantIndex : null;
    if (conv && st.variantIndex !== null) {
      // 重新回答：消息本身不动，只是给它挂一个新版本
      const m = conv.messages.find((x) => x.id === ev.messageId);
      if (m) {
        if (!Array.isArray(m.variants) || !m.variants.length) {
          m.variants = [{ content: m.content || '', reasoning: m.reasoning || '', error: m.error || null }];
        }
        m.variants[st.variantIndex] = { content: '', reasoning: '', error: null };
        m.activeVariant = st.variantIndex;
        m.content = '';
        m.reasoning = '';
        m.error = null;
      }
    } else if (conv) {
      conv.messages.push({
        id: ev.messageId,
        role: 'assistant',
        content: '',
        reasoning: '',
        attachments: [],
        variants: [{ content: '', reasoning: '', error: null }],
        activeVariant: 0,
      });
    }
    if (ev.conversationId === currentId) {
      const target = conv ? conv.messages.find((x) => x.id === ev.messageId) : null;
      st.el = ensureAssistantEl(target || { id: ev.messageId });
      st.bubble = $('.bubble', st.el);
      st.reasonEl = $('.reasoning', st.el);
    }
    return;
  }

  if (ev.type === 'delta') {
    st.text += ev.text;
    if (conv && st.messageId) {
      const m = conv.messages.find((x) => x.id === st.messageId);
      if (m) m.content = st.text;
    }
    scheduleRender(st);
    return;
  }

  if (ev.type === 'reasoning') {
    st.reasoning += ev.text;
    if (conv && st.messageId) {
      const m = conv.messages.find((x) => x.id === st.messageId);
      if (m) m.reasoning = st.reasoning;
    }
    if (st.reasonEl && S.settings.showReasoning !== false) {
      st.reasonEl.classList.remove('hidden');
      st.reasonEl.textContent = st.reasoning;
      if (nearBottom()) scrollToBottom(false);
    }
    return;
  }

  // done / error / stopped
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  const finalMsg = ev.message || {};
  if (conv && st.messageId) {
    const m = conv.messages.find((x) => x.id === st.messageId);
    if (m) {
      m.content = finalMsg.content || st.text;
      m.reasoning = finalMsg.reasoning || st.reasoning;
      m.error = finalMsg.error || null;
      // 版本信息以主进程落盘的为准（版本总数、当前是第几版）
      if (Array.isArray(finalMsg.variants) && finalMsg.variants.length) m.variants = finalMsg.variants;
      if (typeof finalMsg.activeVariant === 'number') m.activeVariant = finalMsg.activeVariant;
    }
  }

  if (st.el && st.conversationId === currentId) {
    if (st.bubble) {
      const html = await api.renderMarkdown(finalMsg.content || st.text || '');
      st.bubble.innerHTML = html;
    }
    if (st.reasonEl && (finalMsg.reasoning || st.reasoning)) {
      st.reasonEl.classList.remove('hidden');
      st.reasonEl.textContent = finalMsg.reasoning || st.reasoning;
      if (S.settings.showReasoning === false) st.reasonEl.classList.add('hidden');
    }
    if (ev.type !== 'done') {
      st.el.classList.add('msg-error');
      const errBox = document.createElement('div');
      errBox.className = 'bubble';
      errBox.textContent = (ev.type === 'stopped' ? '（已停止生成）' : '⚠️ ' + (ev.error || '生成失败'));
      st.el.appendChild(errBox);
    }
    if (!st.text && ev.type !== 'done') {
      const empty = $('.bubble', st.el);
      if (empty && !empty.textContent.trim()) empty.remove();
    }
    // 版本号 + 切换器按最终状态刷新
    const finalLocal = conv ? conv.messages.find((x) => x.id === st.messageId) : null;
    const head = $('.msg-head', st.el);
    if (head && finalLocal) head.innerHTML = '<span>AI</span>' + variantBarHtml(finalLocal);
    if (nearBottom()) scrollToBottom(false);
  }

  if (ev.title && conv) {
    conv.title = ev.title;
    if (conv.id === currentId) el.title.value = ev.title;
  }

  streaming = null;
  updateSendButton();
  renderSidebar();
  if (ev.type === 'error') toast('生成失败：' + (ev.error || ''), true);
}

// ---------------- 设置 ----------------

function closeModal() {
  el.modalRoot.innerHTML = '';
  if (modalKeyHandler) {
    document.removeEventListener('keydown', modalKeyHandler);
    modalKeyHandler = null;
  }
}

let modalKeyHandler = null;

function openModal({ title, body, foot, onMount }) {
  closeModal();
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML =
    '<div class="modal">' +
    '<div class="modal-head"><span>' + esc(title) + '</span><button class="x" data-close>✕</button></div>' +
    '<div class="modal-body"></div>' +
    '<div class="modal-foot"></div>' +
    '</div>';
  const modal = $('.modal', mask);
  $('.modal-body', modal).appendChild(body);
  if (foot) $('.modal-foot', modal).appendChild(foot);
  else $('.modal-foot', modal).remove();

  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-close]')) closeModal();
  });
  modalKeyHandler = (e) => { if (e.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', modalKeyHandler);
  el.modalRoot.appendChild(mask);
  if (onMount) onMount(modal);
  return modal;
}

function openSettings(tab) {
  const body = document.createElement('div');
  const tabs = document.createElement('div');
  tabs.className = 'modal-tabs';
  tabs.innerHTML = '<button data-tab="conn">接口配置</button><button data-tab="general">通用设置</button>';

  const pane = document.createElement('div');

  const render = (which) => {
    $$('button', tabs).forEach((b) => b.classList.toggle('active', b.dataset.tab === which));
    pane.innerHTML = '';
    if (which === 'conn') pane.appendChild(renderConnPane());
    else pane.appendChild(renderGeneralPane());
  };
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) render(b.dataset.tab);
  });

  body.appendChild(tabs);
  body.appendChild(pane);
  render(tab === 'general' ? 'general' : 'conn');

  openModal({ title: '设置', body });
}

function field(label, inputEl, sub) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const lab = document.createElement('label');
  lab.textContent = label;
  wrap.appendChild(lab);
  wrap.appendChild(inputEl);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'sub';
    s.textContent = sub;
    wrap.appendChild(s);
  }
  return wrap;
}

function inputEl(type, value, placeholder) {
  const i = document.createElement('input');
  i.type = type;
  i.value = value || '';
  if (placeholder) i.placeholder = placeholder;
  return i;
}

function renderConnPane() {
  const pane = document.createElement('div');
  const list = document.createElement('div');

  const draw = () => {
    list.innerHTML = '';
    if (!S.connections.length) {
      const tip = document.createElement('div');
      tip.className = 'sub';
      tip.style.marginBottom = '10px';
      tip.textContent = '还没有接口。点下面的「＋ 添加接口」。';
      list.appendChild(tip);
    }

    S.connections.forEach((conn) => {
      const card = document.createElement('div');
      card.className = 'conn-card' + (conn.id === S.activeConnectionId ? ' active' : '');
      const head = document.createElement('div');
      head.className = 'conn-head';
      head.innerHTML =
        '<div class="conn-title"><span>' + esc(conn.name) + '</span>' +
        '<span class="badge' + (conn.id === S.activeConnectionId ? ' on' : '') + '">' +
        (conn.id === S.activeConnectionId ? '当前默认' : typeLabel(conn.type)) + '</span></div>';
      card.appendChild(head);

      const nameIn = inputEl('text', conn.name, '接口名称，例如 DeepSeek');
      const typeSel = document.createElement('select');
      [['openai', 'OpenAI 兼容（DeepSeek / OpenRouter / 中转站…）'],
       ['anthropic', 'Anthropic Claude 官方'],
       ['gemini', 'Google Gemini 官方']].forEach(([v, label]) => {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        if (conn.type === v) o.selected = true;
        typeSel.appendChild(o);
      });
      const baseIn = inputEl('text', conn.baseUrl, 'Base URL，留空用官方默认');
      const keyIn = inputEl('password', conn.apiKey, 'API Key');
      const modelIn = inputEl('text', conn.model, '模型名，例如 deepseek-chat / gpt-4o-mini');
      const dl = document.createElement('datalist');
      dl.id = 'models-' + conn.id;
      modelIn.setAttribute('list', dl.id);
      card.appendChild(dl);

      const row1 = document.createElement('div');
      row1.className = 'row';
      row1.appendChild(field('名称', nameIn));
      row1.appendChild(field('接口类型', typeSel));
      card.appendChild(row1);

      const baseWrap = document.createElement('div');
      baseWrap.appendChild(baseIn);
      card.appendChild(field('Base URL', baseWrap, defaultBaseHint(typeSel.value)));
      const baseHint = $('.sub', baseWrap.parentElement);
      typeSel.addEventListener('change', () => { baseHint.textContent = defaultBaseHint(typeSel.value); });

      card.appendChild(field('API Key', keyIn, '仅保存在本机 ' + (S.appInfo.dataDir || '') + '\\data.json，不会上传任何服务器'));
      card.appendChild(field('模型', modelIn));

      const actions = document.createElement('div');
      actions.className = 'inline-actions';
      const save = document.createElement('button');
      save.className = 'primary-btn';
      save.textContent = '保存';
      const fetchModels = document.createElement('button');
      fetchModels.className = 'ghost-btn';
      fetchModels.textContent = '获取模型列表';
      const makeActive = document.createElement('button');
      makeActive.className = 'ghost-btn';
      makeActive.textContent = '设为当前';
      const del = document.createElement('button');
      del.className = 'danger-btn';
      del.textContent = '删除';

      const collect = () => ({
        name: nameIn.value.trim() || '未命名接口',
        type: typeSel.value,
        baseUrl: baseIn.value.trim(),
        apiKey: keyIn.value.trim(),
        model: modelIn.value.trim(),
      });

      save.addEventListener('click', async () => {
        const patch = collect();
        Object.assign(conn, patch);
        await api.updateConnection(conn.id, patch);
        toast('已保存');
        draw();
      });
      makeActive.addEventListener('click', async () => {
        S.activeConnectionId = conn.id;
        await api.setActiveConnection(conn.id);
        draw();
        renderTopbar();
        toast('已设为当前默认接口');
      });
      del.addEventListener('click', async () => {
        if (!window.confirm('删除接口「' + conn.name + '」？')) return;
        await api.deleteConnection(conn.id);
        S.connections = S.connections.filter((c) => c.id !== conn.id);
        if (S.activeConnectionId === conn.id) S.activeConnectionId = S.connections[0] ? S.connections[0].id : null;
        draw();
        renderTopbar();
      });
      fetchModels.addEventListener('click', async () => {
        await api.updateConnection(conn.id, collect());
        fetchModels.disabled = true;
        fetchModels.textContent = '获取中…';
        try {
          const ids = await api.listModels(conn.id);
          dl.innerHTML = ids.map((id) => '<option value="' + esc(id) + '"></option>').join('');
          toast(ids.length ? `获取到 ${ids.length} 个模型，点击模型输入框可下拉选择` : '接口没有返回模型列表');
        } catch (err) {
          toast('获取失败：' + errText(err), true);
        } finally {
          fetchModels.disabled = false;
          fetchModels.textContent = '获取模型列表';
        }
      });

      actions.appendChild(save);
      actions.appendChild(makeActive);
      actions.appendChild(fetchModels);
      actions.appendChild(del);
      card.appendChild(actions);
      list.appendChild(card);
    });
  };

  draw();

  const addBtn = document.createElement('button');
  addBtn.className = 'primary-btn';
  addBtn.textContent = '＋ 添加接口';
  addBtn.addEventListener('click', async () => {
    const conn = await api.addConnection({ name: '新接口', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: '' });
    S.connections.push(conn);
    if (!S.activeConnectionId) S.activeConnectionId = conn.id;
    draw();
    renderTopbar();
  });

  pane.appendChild(list);
  pane.appendChild(addBtn);
  return pane;
}

function defaultBaseHint(type) {
  if (type === 'anthropic') return '默认 https://api.anthropic.com';
  if (type === 'gemini') return '默认 https://generativelanguage.googleapis.com';
  return '默认 https://api.openai.com/v1；也可直接填以 /chat/completions 结尾的完整地址';
}

function renderGeneralPane() {
  const pane = document.createElement('div');
  const sys = document.createElement('textarea');
  sys.value = S.settings.defaultSystemPrompt || '';
  const temp = inputEl('number', S.settings.defaultTemperature);
  temp.step = '0.1';
  temp.min = '0';
  temp.max = '2';
  const limit = inputEl('number', S.settings.historyLimit);
  limit.min = '2';
  limit.max = '200';

  const showReason = document.createElement('input');
  showReason.type = 'checkbox';
  showReason.checked = S.settings.showReasoning !== false;
  const reasonWrap = document.createElement('label');
  reasonWrap.style.cssText = 'display:flex;align-items:center;gap:8px;color:var(--text-dim)';
  reasonWrap.appendChild(showReason);
  const reasonText = document.createElement('span');
  reasonText.textContent = '显示推理过程（DeepSeek-R1 等 reasoning 模型）';
  reasonWrap.appendChild(reasonText);

  // 主题：三选一，点了立刻生效并保存（属于显示偏好，不必等「保存设置」）
  const themeSeg = document.createElement('div');
  themeSeg.className = 'seg';
  const themeDots = { light: '#f8f5ed', dark: '#0f1a16', system: '#8a958e' };
  const themeBtns = {};
  for (const value of ['light', 'dark', 'system']) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.theme = value;
    const dot = document.createElement('span');
    dot.className = 'seg-dot';
    dot.style.background = themeDots[value];
    b.appendChild(dot);
    b.appendChild(document.createTextNode(THEME_LABEL[value]));
    b.addEventListener('click', async () => {
      await setTheme(value);
      syncThemeButtons();
    });
    themeBtns[value] = b;
    themeSeg.appendChild(b);
  }
  function syncThemeButtons() {
    const mode = themeSetting();
    for (const value of Object.keys(themeBtns)) themeBtns[value].classList.toggle('on', value === mode);
  }
  syncThemeButtons();

  const themeField = field('主题', themeSeg);
  const themeHint = document.createElement('div');
  themeHint.className = 'sub';
  themeHint.textContent = '浅色米白 / 深色深绿；「跟随系统」会跟着 Windows 的浅色深色设置自动切换。顶栏 🌙 按钮也能一键切换。';
  themeField.appendChild(themeHint);
  pane.appendChild(themeField);

  pane.appendChild(field('新对话的默认系统提示词', sys));
  const row = document.createElement('div');
  row.className = 'row';
  row.appendChild(field('默认温度 (0 ~ 2)', temp));
  row.appendChild(field('每次最多发送的历史消息条数', limit));
  pane.appendChild(row);
  pane.appendChild(field('显示', reasonWrap));

  const actions = document.createElement('div');
  actions.className = 'inline-actions';
  const save = document.createElement('button');
  save.className = 'primary-btn';
  save.textContent = '保存设置';
  save.addEventListener('click', async () => {
    const patch = {
      defaultSystemPrompt: sys.value,
      defaultTemperature: Number(temp.value) || 0,
      historyLimit: Math.max(2, Number(limit.value) || 30),
      showReasoning: showReason.checked,
      theme: themeSetting(),
    };
    S.settings = { ...S.settings, ...patch };
    await api.updateSettings(patch);
    toast('设置已保存');
  });
  const openDir = document.createElement('button');
  openDir.className = 'ghost-btn';
  openDir.textContent = '打开数据目录';
  openDir.addEventListener('click', () => api.openDataDir());

  const backupBtn = document.createElement('button');
  backupBtn.className = 'ghost-btn';
  backupBtn.textContent = '导出全部数据（备份）';
  backupBtn.title = '把接口配置、设置、全部对话导出成一个 JSON 文件（含 API Key，请妥善保管）';
  backupBtn.addEventListener('click', backupAllData);

  const restoreBtn = document.createElement('button');
  restoreBtn.className = 'ghost-btn';
  restoreBtn.textContent = '导入数据（恢复）';
  restoreBtn.title = '从备份文件恢复；会覆盖当前对话与接口配置，导入前自动另存现有数据';
  restoreBtn.addEventListener('click', restoreAllData);

  const about = document.createElement('span');
  about.className = 'sub';
  about.textContent = '版本 ' + (S.appInfo.version || '') + ' · Electron ' + (S.appInfo.electron || '');
  const dirLine = document.createElement('div');
  dirLine.className = 'sub';
  dirLine.textContent = '数据目录：' + (S.appInfo.dataDir || '');
  dirLine.title = S.appInfo.dataDir || '';
  dirLine.style.cssText = 'flex-basis:100%;word-break:break-all;color:var(--text-mute)';
  const backupTip = document.createElement('div');
  backupTip.className = 'sub';
  backupTip.style.cssText = 'flex-basis:100%;color:var(--text-mute)';
  backupTip.textContent = '提示：重建/覆盖程序目录时 dist 里的 data 文件夹可能被清掉，' +
    '建议定期用「导出全部数据」存一份到别的地方。导出的是 JSON 纯文本，含 API Key，别外传。';
  actions.appendChild(save);
  actions.appendChild(openDir);
  actions.appendChild(backupBtn);
  actions.appendChild(restoreBtn);
  actions.appendChild(about);
  actions.appendChild(dirLine);
  actions.appendChild(backupTip);
  pane.appendChild(actions);
  return pane;
}

function openConvParams() {
  const conv = currentConv();
  if (!conv) return;
  const body = document.createElement('div');

  const sys = document.createElement('textarea');
  sys.value = conv.systemPrompt || '';
  const temp = inputEl('number', conv.temperature);
  temp.step = '0.1';
  temp.min = '0';
  temp.max = '2';
  const modelIn = inputEl('text', conv.model, '留空使用接口里的默认模型');
  const connSel = document.createElement('select');
  S.connections.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name + ' · ' + typeLabel(c.type);
    if (c.id === conv.connectionId) o.selected = true;
    connSel.appendChild(o);
  });
  if (!S.connections.length) {
    const o = document.createElement('option');
    o.textContent = '（未配置接口）';
    connSel.appendChild(o);
  }

  body.appendChild(field('系统提示词（只影响这个对话）', sys));
  const row = document.createElement('div');
  row.className = 'row';
  row.appendChild(field('温度', temp, '越高越随机，0 最确定'));
  row.appendChild(field('接口', connSel));
  body.appendChild(row);
  body.appendChild(field('模型', modelIn, '会覆盖接口里设置的模型'));

  const foot = document.createElement('div');
  const cancel = document.createElement('button');
  cancel.className = 'ghost-btn';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeModal);
  const save = document.createElement('button');
  save.className = 'primary-btn';
  save.textContent = '保存';
  save.addEventListener('click', async () => {
    const patch = {
      systemPrompt: sys.value,
      temperature: Number(temp.value) || 0,
      model: modelIn.value.trim(),
      connectionId: connSel.value || conv.connectionId,
    };
    Object.assign(conv, patch);
    await api.updateConversation(conv.id, patch);
    renderTopbar();
    closeModal();
    toast('对话参数已保存');
  });
  foot.appendChild(cancel);
  foot.appendChild(save);

  openModal({ title: '对话参数 · ' + conv.title, body, foot });
}

init().catch((err) => {
  document.body.innerHTML = '<pre style="padding:24px;color:var(--danger-text)">启动失败：' + esc(errText(err)) + '</pre>';
});

})();
