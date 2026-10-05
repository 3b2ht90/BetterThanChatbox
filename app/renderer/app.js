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
  pathChips: $('#path-chips'),
  ctxIsland: $('#ctx-island'),
  send: $('#btn-send'),
  attach: $('#btn-attach'),
  newBtn: $('#btn-new'),
  importBtn: $('#btn-import'),
  settings: $('#btn-settings'),
  title: $('#conv-title'),
  connSelect: $('#conn-select'),
  modelPicker: $('#model-picker'),
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
let modelPicker = null; // 顶栏的模型下拉
let detectedPaths = [];   // 输入框里认出来的本地路径（本次要发给 AI 的）
let refusedPaths = new Set(); // 用户手动 ✕ 掉的路径，改完文字再重新认
let pathProbeTimer = null;

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
  // 顶栏的模型下拉：选中后立刻写进当前对话
  modelPicker = createModelPicker(el.modelPicker, {
    getContext: () => {
      const conv = currentConv();
      const conn = connOf(conv) || S.connections.find((c) => c.id === S.activeConnectionId) || null;
      return {
        connectionId: conn ? conn.id : null,
        conversationId: conv ? conv.id : null,
        model: conv ? conv.model || '' : '',
        connModel: conn ? conn.model || '' : '',
      };
    },
    onPick: async (model) => {
      const conv = currentConv();
      if (!conv) return;
      conv.model = model;
      await api.updateConversation(conv.id, { model });
      updateHint();
      toast(model ? '已切换模型：' + model : '已改为使用接口默认模型');
    },
  });

  el.newBtn.addEventListener('click', newConversation);
  el.importBtn.addEventListener('click', importConversations);
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
  el.input.addEventListener('input', () => { autoResize(); schedulePathProbe(); });

  el.title.addEventListener('change', () => renameConversation(currentId, el.title.value));
  el.title.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.title.blur(); });

  el.connSelect.addEventListener('change', async () => {
    const conv = currentConv();
    if (!conv) return;
    conv.connectionId = el.connSelect.value;
    await api.updateConversation(conv.id, { connectionId: conv.connectionId });
    const conn = connOf(conv);
    toast('本对话接口已切换为：' + (conn ? conn.name : '未配置'));
    modelPicker.reload(); // 换了接口，模型列表跟着换
  });

  el.messages.addEventListener('click', onMessageClick);
  // 上下文灵动岛：点胶囊展开/收起，面板里再点具体动作
  el.ctxIsland.addEventListener('click', (e) => {
    // 标记一下这次点击来自岛内。注意：下面会重建 innerHTML，重建后 e.target 就从 DOM 上脱离了，
    // 用 e.target.closest('#ctx-island') 在后面的 document 监听器里会返回 null，
    // 于是刚展开就被"点外面收起"的逻辑收回去（踩过这个坑）。
    e.__fromIsland = true;
    const b = e.target.closest('[data-ctx]');
    if (!b) return;
    const act = b.dataset.ctx;
    if (act === 'toggle') { ctxOpen = !ctxOpen; renderCtxIsland(); return; }
    if (act === 'close') { ctxOpen = false; renderCtxIsland(); return; }
    if (b.disabled) return;
    if (act === 'compact') compactContext();
    else if (act === 'uncompact') uncompactContext();
  });
  // 点别处自动收起（别让面板一直占着）
  document.addEventListener('click', (e) => {
    if (!ctxOpen) return;
    if (e.__fromIsland) return;
    if (e.target && e.target.closest && e.target.closest('#ctx-island')) return;
    ctxOpen = false;
    renderCtxIsland();
  });
  el.pathChips.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-unpath]');
    if (btn) {
      refusedPaths.add(btn.dataset.unpath);
      detectedPaths = detectedPaths.filter((i) => i.path !== btn.dataset.unpath);
      renderPathChips();
      return;
    }
    const open = e.target.closest('[data-open-path]');
    if (open) api.openAttachment(open.dataset.openPath);
  });
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

// ---------------- 导入对话 ----------------

async function importConversations() {
  try {
    const res = await api.importConversations();
    if (res.canceled) return;
    if (res.error || !res.imported) {
      toast('导入失败：' + (res.error || '没有可导入的内容'), true);
      return;
    }
    // 重新从主进程拉一遍完整状态（导入的对话 id 都是新生成的）
    S = await api.getState();
    const first = res.conversations && res.conversations[0];
    if (first) currentId = first.id;
    renderSidebar();
    renderTopbar();
    await renderMessages();

    let msg = `已导入 ${res.imported} 个对话、${res.messages} 条消息`;
    if (res.missingAtts) msg += `；其中 ${res.missingAtts} 个附件原文件不在本机，只保留了名字`;
    toast(msg);
    if (res.errors && res.errors.length) {
      toast('有文件没导入成功：' + res.errors.join('；'), true);
    }
  } catch (err) {
    toast('导入失败：' + errText(err), true);
  }
}

/** 自动备份面板：列出程序自动留存的历史快照，可一键恢复 */
async function openBackups() {
  let data = { list: [], dir: '' };
  try {
    data = await api.listBackups();
  } catch (err) {
    toast('读取备份列表失败：' + errText(err), true);
    return;
  }
  const body = document.createElement('div');
  const tip = document.createElement('div');
  tip.className = 'sub';
  tip.style.cssText = 'margin-bottom:10px;color:var(--text-mute);line-height:1.7';
  tip.textContent = '程序每次启动都会把上一份数据留成快照（保留最近 20 份 + 每天一份）。' +
    '数据被误删、写坏、或者目录被换掉时，可以从这里退回去。当前的数据在恢复前也会自动留一份。';
  body.appendChild(tip);

  if (!data.list.length) {
    const none = document.createElement('div');
    none.className = 'sub';
    none.textContent = '还没有快照 —— 重启一次程序之后就会出现第一份。';
    body.appendChild(none);
  } else {
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:8px;max-height:46vh;overflow:auto';
    data.list.forEach((b, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:8px';
      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';
      const when = new Date(b.mtime);
      const c = b.counts || {};
      info.innerHTML = '<div>' + esc(when.toLocaleString()) +
        (i === 0 ? ' <span class="badge on">最近</span>' : '') + '</div>' +
        '<div class="sub" style="color:var(--text-mute)">接口 ' + (c.connections != null ? c.connections : '?') +
        ' 个 · 对话 ' + (c.conversations != null ? c.conversations : '?') +
        ' 个 · 消息 ' + (c.messages != null ? c.messages : '?') + ' 条 · ' + fmtSize(b.size) + '</div>';
      const btn = document.createElement('button');
      btn.className = 'ghost-btn';
      btn.textContent = '恢复这份';
      btn.addEventListener('click', async () => {
        try {
          const res = await api.restoreBackup(b.name);
          if (res.canceled) return;
          S = await api.getState();
          currentId = S.conversations[0] ? S.conversations[0].id : null;
          renderSidebar();
          renderTopbar();
          await renderMessages();
          closeModal();
          toast(`已恢复：接口 ${res.counts.connections} 个、对话 ${res.counts.conversations} 个`);
        } catch (err) {
          toast('恢复失败：' + errText(err), true);
        }
      });
      row.appendChild(info);
      row.appendChild(btn);
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  const dirLine = document.createElement('div');
  dirLine.className = 'sub';
  dirLine.style.cssText = 'margin-top:10px;color:var(--text-mute);word-break:break-all';
  dirLine.textContent = '快照位置：' + (data.dir || '');
  body.appendChild(dirLine);

  openModal('自动备份', body, [{ text: '关闭', primary: true, onClick: closeModal }]);
}

// ---------------- 上下文「灵动岛」+ 压缩 ----------------

let ctxTimer = null;
let ctxInfo = null;        // 最近一次拿到的用量信息
let ctxOpen = false;       // 面板是否展开

/** 刷新用量（防抖：消息多的时候别每次重算） */
function scheduleContextInfo(delay = 200) {
  if (ctxTimer) clearTimeout(ctxTimer);
  ctxTimer = setTimeout(() => {
    ctxTimer = null;
    refreshContextInfo();
  }, delay);
}

async function refreshContextInfo() {
  const conv = currentConv();
  if (!conv || !el.ctxIsland) return;
  let info = null;
  try {
    info = await api.contextInfo(conv.id);
  } catch { /* 拿不到就不显示，不影响使用 */ }
  if (!info || conv.id !== currentId) return;
  ctxInfo = info;
  renderCtxIsland();
}

/** 渲染灵动岛：平时只有一个小胶囊，点开才是详情面板 */
function renderCtxIsland() {
  const info = ctxInfo;
  if (!info || !el.ctxIsland) return;
  const pct = Math.max(0, Math.min(100, Number(info.percent) || 0));
  el.ctxIsland.classList.remove('hidden', 'low', 'mid', 'high', 'compressed');
  el.ctxIsland.classList.add(info.level || 'low');
  if (info.compressed) el.ctxIsland.classList.add('compressed');

  const pill =
    '<div class="ctx-pill" data-ctx="toggle" title="点一下看上下文详情（用量、窗口大小、压缩）">' +
    '<span class="pill-dot" style="--pct:' + pct + '"></span>' +
    '<span class="pill-pct">' + pct + '%</span>' +
    '<span class="pill-extra">' + (info.compressed ? '已压缩 ' + info.compressed + ' 条' : '上下文') + '</span>' +
    '</div>';

  if (!ctxOpen) {
    el.ctxIsland.innerHTML = pill;
    return;
  }

  el.ctxIsland.innerHTML = pill +
    '<div class="ctx-panel">' +
    '<div class="cp-row"><span class="cp-big">约 ' + fmtTokens(info.tokens) + '</span>' +
    '<span class="cp-sub">/ ' + fmtTokens(info.limit) + ' tokens（' + pct + '%）</span></div>' +
    '<div class="cp-track"><div class="cp-fill" style="width:' + pct + '%"></div></div>' +
    '<div class="cp-line">模型：' + esc(info.model || '（用接口默认）') + '</div>' +
    '<div class="cp-line">这里的 token 数是按字数估的（中文 1 字 ≈ 1 token、英文 4 字符 ≈ 1 token），' +
    '窗口大小按模型名自动匹配，认不出来按 128k 算 —— 都可以在「设置 → 接口」里手填覆盖。</div>' +
    (info.compressed ? '<div class="cp-line">已压缩 ' + info.compressed + ' 条消息（原文仍在对话里，可展开查看）</div>' : '') +
    '<div class="cp-actions">' +
    (info.compressed ? '<button data-ctx="uncompact">取消压缩</button>' : '') +
    '<button class="' + (info.level === 'high' ? 'primary' : '') + '" data-ctx="compact"' +
    (info.canCompress ? '' : ' disabled') +
    ' title="把较早的对话总结成一段摘要；原文保留、可展开查看">压缩上下文</button>' +
    '<button data-ctx="close">收起</button>' +
    '</div></div>';
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
  return String(v);
}

async function compactContext() {
  const conv = currentConv();
  if (!conv) return;
  if (streaming) { toast('正在生成中，等这次回答结束再压缩', true); return; }
  const btn = el.ctxIsland.querySelector('[data-ctx="compact"]');
  if (btn) { btn.disabled = true; btn.textContent = '正在压缩…'; }
  try {
    const res = await api.compactContext(conv.id);
    S = await api.getState();
    await renderMessages();
    await refreshContextInfo();
    toast(`已压缩 ${res.compressedCount} 条消息；压缩后上下文约 ${fmtTokens(res.usage.tokens)} tokens`);
  } catch (err) {
    toast('压缩失败：' + errText(err), true);
    scheduleContextInfo(0);
  }
}

async function uncompactContext() {
  const conv = currentConv();
  if (!conv) return;
  try {
    const res = await api.uncompactContext(conv.id);
    S = await api.getState();
    await renderMessages();
    await refreshContextInfo();
    toast(`已取消压缩，${res.restored} 条原文重新参与上下文`);
  } catch (err) {
    toast('取消失败：' + errText(err), true);
  }
}

async function switchConversation(id) {
  if (id === currentId) return;
  currentId = id;
  pendingAtts = [];
  renderPending();
  renderSidebar();
  renderTopbar();
  await renderMessages();
  el.input.focus();
}

// ---------------- 模型下拉选择器 ----------------

/**
 * 顶栏/参数面板共用的模型选择器。
 * opts.getContext() → { connectionId, conversationId, model, connModel }
 * opts.onPick(model) → 选中后干什么（顶栏是立刻保存，参数面板只是记下来等保存）
 */
function createModelPicker(container, opts) {
  const root = document.createElement('div');
  root.className = 'mp';
  root.innerHTML =
    '<button type="button" class="mp-btn" title="切换模型">' +
    '<span class="mp-label">接口默认</span><span class="mp-caret">▾</span>' +
    '</button>' +
    '<div class="mp-panel hidden">' +
    '<div class="mp-head">' +
    '<input class="mp-search" type="text" placeholder="搜索或直接输入模型名…" spellcheck="false">' +
    '<button type="button" class="mp-refresh" title="重新从接口获取模型列表">↻</button>' +
    '</div>' +
    '<div class="mp-list"></div>' +
    '<div class="mp-foot"></div>' +
    '</div>';
  container.appendChild(root);

  const btn = $('.mp-btn', root);
  const label = $('.mp-label', root);
  const panel = $('.mp-panel', root);
  const search = $('.mp-search', root);
  const listEl = $('.mp-list', root);
  const foot = $('.mp-foot', root);
  const refresh = $('.mp-refresh', root);

  let data = { groups: [], fetchedAt: null, hasCache: false };
  let query = '';
  let loading = false;
  let opened = false;

  function close() {
    if (!opened) return;
    opened = false;
    panel.classList.add('hidden');
    document.removeEventListener('mousedown', onDocDown, true);
  }

  function onDocDown(e) {
    if (!root.contains(e.target)) close();
  }

  function open() {
    if (opened) return;
    opened = true;
    panel.classList.remove('hidden');
    query = '';
    search.value = '';
    document.addEventListener('mousedown', onDocDown, true);
    reload().then(() => search.focus());
  }

  function updateButton() {
    const ctx = opts.getContext() || {};
    const shown = ctx.model || ctx.connModel || '';
    label.textContent = shown || '接口默认';
    root.classList.toggle('is-default', !ctx.model);
    btn.title = ctx.model
      ? '当前模型：' + ctx.model + '（点击切换）'
      : '当前用接口默认模型' + (ctx.connModel ? '：' + ctx.connModel : '') + '（点击切换）';
  }

  /** 只拉本地已有的信息（不联网），用于打开面板和切对话时立即刷新 */
  async function reload() {
    const ctx = opts.getContext() || {};
    updateButton();
    try {
      data = await api.suggestModels(ctx.connectionId, ctx.conversationId);
    } catch {
      data = { groups: [], fetchedAt: null, hasCache: false };
    }
    renderList();
    // 第一次打开且没有任何可用列表时，自动去接口拉一次
    if (opened && !data.hasCache && !loading && ctx.connectionId) fetchNow({ silent: true });
  }

  async function fetchNow({ silent } = {}) {
    const ctx = opts.getContext() || {};
    if (!ctx.connectionId) {
      if (!silent) toast('还没有配置接口，先去设置里添加一个', true);
      return;
    }
    loading = true;
    renderList();
    try {
      const res = await api.fetchModels(ctx.connectionId);
      const conn = S.connections.find((c) => c.id === ctx.connectionId);
      if (conn) {
        conn.models = res.models;
        conn.modelsFetchedAt = res.fetchedAt;
      }
      data = await api.suggestModels(ctx.connectionId, ctx.conversationId);
      renderList();
      toast(res.count ? `获取到 ${res.count} 个模型` : '接口没有返回模型列表');
    } catch (err) {
      renderList(String(errText(err)));
      if (!silent) toast('获取模型列表失败：' + errText(err), true);
    } finally {
      loading = false;
      renderList();
    }
  }

  function pick(model) {
    const ctx = opts.getContext() || {};
    if ((ctx.model || '') === model) {
      close();
      return;
    }
    opts.onPick(model);
    updateButton();
    close();
  }

  function renderList(errorText) {
    const ctx = opts.getContext() || {};
    const flat = [];
    for (const g of data.groups || []) {
      for (const m of g.models) flat.push({ group: g.label, model: m });
    }
    const q = query.trim();
    const ql = q.toLowerCase();
    const filtered = ql ? flat.filter((x) => x.model.toLowerCase().includes(ql)) : flat;

    const rows = [];
    // 第一项永远是「用接口默认」
    rows.push(
      '<div class="mp-item' + (!ctx.model ? ' active' : '') + '" data-model="">' +
      '<span class="mp-check">' + (!ctx.model ? '✓' : '') + '</span>' +
      '<span class="mp-name">用接口默认' +
      (ctx.connModel ? '（' + esc(ctx.connModel) + '）' : '（未设置）') + '</span></div>'
    );

    if (q && !flat.some((x) => x.model.toLowerCase() === ql)) {
      rows.push(
        '<div class="mp-item mp-custom" data-model="' + esc(q) + '">' +
        '<span class="mp-check"></span><span class="mp-name">使用「' + esc(q) + '」</span>' +
        '<span class="mp-tag">自定义</span></div>'
      );
    }

    let lastGroup = null;
    for (const row of filtered) {
      if (row.group !== lastGroup) {
        rows.push('<div class="mp-group">' + esc(row.group) + '</div>');
        lastGroup = row.group;
      }
      const active = row.model === ctx.model;
      rows.push(
        '<div class="mp-item' + (active ? ' active' : '') + '" data-model="' + esc(row.model) + '" title="' + esc(row.model) + '">' +
        '<span class="mp-check">' + (active ? '✓' : '') + '</span>' +
        '<span class="mp-name">' + esc(row.model) + '</span></div>'
      );
    }

    // 注意：即使一条都没匹配上，也必须保留上面 push 的「用接口默认 / 使用自定义」两项，
    // 否则用户搜一个列表里没有的模型名时，连点都没得点（只能靠按 Enter）。
    if (loading) {
      listEl.innerHTML = '<div class="mp-hint">正在从接口获取模型列表…</div>';
      return;
    }
    let html = rows.join('');
    if (errorText) {
      html = '<div class="mp-hint mp-err">获取失败：' + esc(errorText) + '</div>' + html;
    } else if (!flat.length) {
      html += '<div class="mp-hint">还没有模型列表，点右上角 ↻ 从接口获取（或在上面直接输入模型名）</div>';
    } else if (!filtered.length) {
      html += '<div class="mp-hint">没有匹配「' + esc(q) + '」的模型，点上面的选项或直接按 Enter 用它</div>';
    }
    listEl.innerHTML = html;

    const when = data.fetchedAt ? new Date(data.fetchedAt).toLocaleString() : '';
    foot.textContent = data.hasCache
      ? `共 ${flat.length} 个可选模型 · 列表更新于 ${when}`
      : '列表为空时可在上方直接输入模型名';
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (opened) close();
    else open();
  });
  refresh.addEventListener('click', (e) => {
    e.stopPropagation();
    fetchNow({});
  });
  search.addEventListener('input', () => {
    query = search.value;
    renderList();
  });
  search.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') return close();
    if (e.key !== 'Enter') return;
    const q = search.value.trim();
    if (!q) return;
    const exact = (data.groups || []).some((g) => g.models.some((m) => m.toLowerCase() === q.toLowerCase()));
    pick(exact ? (data.groups.flatMap((g) => g.models).find((m) => m.toLowerCase() === q.toLowerCase())) : q);
  });
  listEl.addEventListener('click', (e) => {
    const item = e.target.closest('.mp-item');
    if (item) pick(item.dataset.model || '');
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  updateButton();
  return {
    el: root,
    reload,
    close,
    updateButton,
    get value() { return (opts.getContext() || {}).model || ''; },
  };
}

// ---------------- 顶栏 ----------------

function renderTopbar() {
  const conv = currentConv();
  if (!conv) return;
  el.title.value = conv.title || '';
  if (modelPicker) modelPicker.reload();

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

// ---------------- 思考过程 ----------------

/**
 * 思考过程块：完整内容始终留在 DOM 里（可以选中、Ctrl+F 搜索、整段复制），
 * 默认展开、可折叠，「展开」还能解除内部滚动条一次看完全文。
 * 流式阶段用 append 追加（而不是每次重设整串），长思考也不会卡。
 */
function buildReasoningEl(text, opts = {}) {
  const box = document.createElement('div');
  box.className = 'reasoning' + (opts.streaming ? ' streaming' : '');
  box.innerHTML =
    '<div class="r-head">' +
    '<span class="r-title">💭 ' + (opts.streaming ? '正在思考…' : '思考过程') + '</span>' +
    '<span class="r-meta"></span>' +
    '<span class="r-spacer"></span>' +
    '<button type="button" class="r-copy" title="复制完整的思考过程">复制</button>' +
    '<button type="button" class="r-toggle"></button>' +
    '</div>' +
    '<pre class="r-body"></pre>';

  const body = $('.r-body', box);
  const meta = $('.r-meta', box);
  const toggle = $('.r-toggle', box);
  const copy = $('.r-copy', box);

  const syncMeta = () => {
    const n = body.textContent.length;
    meta.textContent = n ? n.toLocaleString() + ' 字' : '';
  };
  const syncToggle = () => {
    const collapsed = box.classList.contains('collapsed');
    toggle.textContent = collapsed ? '展开' : '收起';
  };

  // 有内容就默认展开；外面可以传 collapsed 指定
  if (opts.collapsed) box.classList.add('collapsed');
  syncToggle();
  if (text) {
    body.textContent = text;
    syncMeta();
  }

  $('.r-head', box).addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    box.classList.toggle('collapsed');
    box.classList.remove('expanded');
    syncToggle();
  });
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (box.classList.contains('collapsed')) {
      box.classList.remove('collapsed');
    } else {
      // 已经是展开状态：再点一次在「限高滚动」和「全文铺开」之间切换
      box.classList.toggle('expanded');
    }
    syncToggle();
  });
  copy.addEventListener('click', async (e) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(body.textContent || '');
    copy.textContent = '已复制';
    setTimeout(() => { copy.textContent = '复制'; }, 1200);
  });

  box.__append = (chunk) => {
    body.appendChild(document.createTextNode(chunk));
    syncMeta();
  };
  box.__setText = (t) => {
    body.textContent = t || '';
    syncMeta();
  };
  box.__getText = () => body.textContent || '';
  box.__setStreaming = (on) => {
    box.classList.toggle('streaming', !!on);
    $('.r-title', box).textContent = on ? '💭 正在思考…' : '💭 思考过程';
  };
  return box;
}

// ---------------- 消息渲染 ----------------

function attachmentHtml(att, opts = {}) {
  // 导入的对话：附件原文件在别的电脑上，这里只保留名字
  if (att.missing) {
    const icon = att.kind === 'image' ? '🖼' : att.kind === 'folder' ? '📁' : '📄';
    return '<div class="att warn" title="' + esc(att.name + '：原文件不在本机，只保留了这条记录') + '">' +
      '<span>' + icon + '</span>' +
      '<span class="att-name">' + esc(att.name) + '</span>' +
      '<span class="att-size">原文件不在本机</span>' +
      (opts.removable ? '<button class="att-x" data-remove="' + esc(att.id) + '" title="移除">✕</button>' : '') +
      '</div>';
  }
  if (att.kind === 'image') {
    return '<div class="att-thumb" data-open="' + esc(att.path) + '" title="' + esc(att.name + ' · ' + fmtSize(att.size)) + '">' +
      '<img src="' + esc(att.url) + '" alt="' + esc(att.name) + '"></div>';
  }
  // 文件夹：正文是发请求时现读的，这里只显示路径和清单
  if (att.kind === 'folder') {
    return '<div class="att clickable" data-open="' + esc(att.path) + '" title="' +
      esc(att.path + '（点一下在资源管理器里打开）') + '">' +
      '<span>📁</span>' +
      '<span class="att-name">' + esc(att.name) + '/</span>' +
      '<span class="att-size">' + (att.fileCount || 0) + ' 个文件 · ' + esc(fmtSize(att.totalBytes)) +
      (att.skippedCount ? ' · 跳过 ' + att.skippedCount + ' 项' : '') + '</span>' +
      (opts.removable ? '<button class="att-x" data-remove="' + esc(att.id) + '" title="移除">✕</button>' : '') +
      '</div>';
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

/** 这条消息该存到哪个文件夹：从它自己往前找最近一条带文件夹附件的消息 */
function folderAttForMessage(conv, msg) {
  const list = (conv && conv.messages) || [];
  let idx = list.findIndex((m) => m.id === msg.id);
  if (idx < 0) idx = list.length - 1;
  for (let i = idx; i >= 0; i--) {
    const f = (list[i].attachments || []).find((a) => a && a.kind === 'folder' && a.path);
    if (f) return f;
  }
  return null;
}

/** AI 回复上的「保存为文件 / 保存到 xxx」按钮 */
function saveButtonHtml(conv, msg, folderAtt) {
  if (msg.role !== 'assistant' || !msg.content) return '';
  return '<button data-act="save" title="' +
    esc(folderAtt ? '保存到 ' + folderAtt.path : '保存成一个本地 .md 文件') + '">💾 ' +
    esc(folderAtt ? '保存到 ' + folderAtt.name + '/' : '保存为文件') + '</button>';
}

/** 回答被截断 / 被中断时的提示条（挂在消息下面，并给一个「继续写」的出口） */
function truncationNoticeEl(msg) {
  if (!msg || (!msg.truncated && !msg.endedEarly)) return null;
  const box = document.createElement('div');
  box.className = 'trunc-note' + (msg.endedEarly ? ' early' : '');
  const reason = msg.finishReason ? '接口报告的结束原因：' + msg.finishReason : '接口没有给出结束原因';
  box.innerHTML =
    '<div class="tn-title">' + (msg.endedEarly ? '⚠️ 这条回答可能是被中途切断的' : '✂️ 这条回答达到了输出长度上限，后面被截断了') + '</div>' +
    '<div class="tn-sub">' + esc(reason) +
    '。中转站和模型通常有默认输出上限（常见 4096，甚至 1024），长回答会在这里停住。' +
    '可以把「设置 → 通用设置 → 默认最大输出 tokens」调大（例如 8192），或者直接让它接着写。</div>' +
    '<div class="tn-actions"><button class="ghost-btn" data-act="continue">接着写</button></div>';
  box.querySelector('[data-act="continue"]').addEventListener('click', () => {
    const input = el.input;
    input.value = '上一条回答被截断了（' + (msg.finishReason || '未给出原因') +
      '）。请**从中断处继续**写完，不要重复已经说过的内容，也不要重新开头。';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    onSendOrStop();
  });
  return box;
}

async function buildMessageEl(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (msg.role === 'user' ? 'msg-user' : 'msg-assistant') + (msg.error ? ' msg-error' : '');
  wrap.dataset.id = msg.id;

  const head = document.createElement('div');
  head.className = 'msg-head';
  head.innerHTML = '<span>' + (msg.role === 'user' ? '你' : (msg.isSummary ? '📄 上下文摘要' : 'AI')) + '</span>' + variantBarHtml(msg);
  wrap.appendChild(head);
  if (msg.isSummary) wrap.classList.add('msg-summary');

  if (msg.attachments && msg.attachments.length) {
    const atts = document.createElement('div');
    atts.className = 'atts';
    atts.innerHTML = msg.attachments.map((a) => attachmentHtml(a)).join('');
    wrap.appendChild(atts);
  }

  if (msg.reasoning) {
    wrap.appendChild(buildReasoningEl(msg.reasoning));
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (msg.content) {
    bubble.innerHTML = await api.renderMarkdown(msg.content);
  }
  wrap.appendChild(bubble);

  // 被截断 / 被切断时给出明确提示（不能装作正常结束）
  const notice = truncationNoticeEl(msg);
  if (notice) wrap.appendChild(notice);

  const tools = document.createElement('div');
  tools.className = 'msg-tools';
  // AI 回复可以一键存成本地文件；如果这条提问带了文件夹路径，就默认存回那个文件夹
  const folderAtt = folderAttForMessage(currentConv(), msg);
  tools.innerHTML =
    '<button data-act="copy">复制</button>' +
    saveButtonHtml(currentConv(), msg, folderAtt) +
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
  // 已压缩的消息收成一组（默认折叠），点一下能展开看原文 —— 内容一点没丢
  const showCompressed = conv._showCompressed === true;
  let i = 0;
  while (i < conv.messages.length) {
    const msg = conv.messages[i];
    if (msg.compressed && !showCompressed) {
      const start = i;
      while (i < conv.messages.length && conv.messages[i].compressed) i++;
      el.messages.appendChild(compressedGroupEl(conv, conv.messages.slice(start, i)));
      continue;
    }
    el.messages.appendChild(await buildMessageEl(msg));
    i++;
  }
  scrollToBottom(false);
  scheduleContextInfo(0);
}

/** 已压缩消息的折叠条 */
function compressedGroupEl(conv, msgs) {
  const box = document.createElement('div');
  box.className = 'msg-compressed-group';
  const expanded = conv._showCompressed === true;
  box.innerHTML = '<span>' + (expanded ? '▾' : '▸') + '</span>' +
    '<span class="cg-count">已压缩 ' + msgs.length + ' 条消息</span>' +
    '<span>（内容已并入下方的「上下文摘要」，原文仍在这里，点一下' + (expanded ? '收起' : '展开') + '）</span>';
  box.addEventListener('click', async () => {
    conv._showCompressed = !expanded;
    await renderMessages();
  });
  return box;
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
  } else if (btn.dataset.act === 'save') {
    // 一键把这条回复存成本地文件；带文件夹附件的默认存回那个文件夹
    try {
      const res = await api.saveMessage(conv.id, msg.id, '');
      if (res.canceled) return;
      toast('已保存到：' + res.path);
      btn.textContent = '💾 已保存';
      setTimeout(() => { btn.textContent = '💾 保存为文件'; }, 2000);
    } catch (err) {
      toast('保存失败：' + errText(err), true);
    }
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

// ---------------- 本地路径（发一个文件夹路径 → AI 读里面的文档） ----------------

function schedulePathProbe() {
  if (pathProbeTimer) clearTimeout(pathProbeTimer);
  const text = el.input.value;
  // 没有任何盘符/UNC 的迹象就直接清掉，省一次 IPC
  if (!/[A-Za-z]:[\\/]|\\\\/.test(text)) {
    detectedPaths = [];
    refusedPaths.clear();
    renderPathChips();
    return;
  }
  pathProbeTimer = setTimeout(probePaths, 350);
}

async function probePaths() {
  pathProbeTimer = null;
  try {
    const res = await api.probePath(el.input.value);
    detectedPaths = (res.items || []).filter((it) => !refusedPaths.has(it.path));
  } catch {
    detectedPaths = [];
  }
  renderPathChips();
}

function renderPathChips() {
  if (!detectedPaths.length) {
    el.pathChips.classList.add('hidden');
    el.pathChips.innerHTML = '';
    return;
  }
  el.pathChips.classList.remove('hidden');
  el.pathChips.innerHTML = detectedPaths.map((it) => {
    if (it.kind === 'missing') {
      return '<div class="path-chip blocked" title="' + esc(it.path) + '">' +
        '<span class="pc-icon">⛔</span>' +
        '<span class="pc-name">' + esc(it.name) + '</span>' +
        '<span class="pc-meta">本机找不到这个路径，不会被读取（检查有没有拼错、盘符对不对）</span></div>';
    }
    if (it.kind === 'blocked') {
      return '<div class="path-chip blocked" title="' + esc(it.warning) + '">' +
        '<span class="pc-icon">⛔</span>' +
        '<span class="pc-name">' + esc(it.path) + '</span>' +
        '<span class="pc-meta">' + esc(it.warning) + '，不会被读取</span></div>';
    }
    if (it.kind === 'folder') {
      const meta = `${it.fileCount} 个可读文件 · ${fmtSize(it.totalBytes)}` +
        (it.truncated ? ' · 超出上限，只读前一部分' : '') +
        (it.skippedCount ? ` · 跳过 ${it.skippedCount} 项` : '') + ' · 发送时读取内容';
      return '<div class="path-chip" title="' + esc(it.path) + '">' +
        '<span class="pc-icon">📁</span>' +
        '<span class="pc-name" data-open-path="' + esc(it.path) + '">' + esc(it.name) + '/</span>' +
        '<span class="pc-meta">' + esc(meta) + '</span>' +
        '<button class="pc-x" data-unpath="' + esc(it.path) + '" title="这次不读它">✕</button></div>';
    }
    const label = it.kind === 'image' ? '图片（按视觉消息发送）' : '文件 · ' + fmtSize(it.size);
    return '<div class="path-chip" title="' + esc(it.path) + '">' +
      '<span class="pc-icon">📄</span>' +
      '<span class="pc-name" data-open-path="' + esc(it.path) + '">' + esc(it.name) + '</span>' +
      '<span class="pc-meta">' + esc(label) + '</span>' +
      '<button class="pc-x" data-unpath="' + esc(it.path) + '" title="这次不读它">✕</button></div>';
  }).join('');
}

/** 把输入框里认出来的路径变成真正的附件（发送前调用） */
async function attachDetectedPaths() {
  const wanted = detectedPaths.filter((i) => i.kind === 'folder' || i.kind === 'file' || i.kind === 'image');
  if (!wanted.length) return [];
  try {
    const metas = await api.attachPath(wanted.map((i) => i.path));
    const out = [];
    for (const m of metas) {
      if (m && m.error) { toast('路径读取失败：' + m.error, true); continue; }
      out.push(m);
    }
    return out;
  } catch (err) {
    toast('路径读取失败：' + errText(err), true);
    return [];
  }
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

  // 输入框里认出来的本地路径 → 附件（文件夹只记路径，正文发请求时现读）
  const pathAtts = await attachDetectedPaths();

  const msg = await api.appendMessage(conv.id, {
    role: 'user',
    content: text,
    attachments: [...pendingAtts.slice(), ...pathAtts],
  });
  conv.messages.push(msg);

  pendingAtts = [];
  detectedPaths = [];
  refusedPaths.clear();
  renderPending();
  renderPathChips();
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
  const conv = currentConv();
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';
  wrap.dataset.id = msg.id;
  // 这里的工具条必须和 buildMessageEl 保持一致：流式结束后留在屏幕上的就是这个元素
  wrap.innerHTML =
    '<div class="msg-head"><span>AI</span>' + variantBarHtml(msg) + '</div>' +
    '<div class="bubble"><span class="cursor-blink"></span></div>' +
    '<div class="msg-tools">' +
    '<button data-act="copy">复制</button>' +
    saveButtonHtml(conv, { role: 'assistant', content: '…' }, folderAttForMessage(conv, msg)) +
    '<button data-act="retry">重新回答</button><button data-act="del">删除</button>' +
    '</div>';
  // 思考过程块按需插入（插在气泡前面），没思考就不占位置
  const reasonBox = buildReasoningEl('', { streaming: true });
  reasonBox.classList.add('hidden');
  $('.bubble', wrap).before(reasonBox);
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
      if (st.reasonEl.classList.contains('hidden')) {
        st.reasonEl.classList.remove('hidden');
        st.reasonEl.__setStreaming(true);
      }
      // 只追加新片段：不要每次重设整串，否则长思考会越来越卡
      st.reasonEl.__append(ev.text);
      const body = $('.r-body', st.reasonEl);
      const stick = body && (body.scrollHeight - body.scrollTop - body.clientHeight < 60);
      if (body && stick) body.scrollTop = body.scrollHeight;
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
      // 「为什么结束」也要同步过来 —— 少了它，下面那段提示会因为
      // 本地这条消息没有 truncated 标记而直接跳过（踩过这个坑：toast 响了、提示条没出来）
      if (typeof finalMsg.truncated === 'boolean') m.truncated = finalMsg.truncated;
      if (typeof finalMsg.endedEarly === 'boolean') m.endedEarly = finalMsg.endedEarly;
      if (finalMsg.finishReason !== undefined) m.finishReason = finalMsg.finishReason;
    }
  }

  if (st.el && st.conversationId === currentId) {
    if (st.bubble) {
      const html = await api.renderMarkdown(finalMsg.content || st.text || '');
      st.bubble.innerHTML = html;
    }
    if (st.reasonEl && (finalMsg.reasoning || st.reasoning)) {
      st.reasonEl.classList.remove('hidden');
      st.reasonEl.__setStreaming(false);
      // 以落盘的完整文本为准（顺便兜住最后几片没来得及追加的）
      const finalReasoning = finalMsg.reasoning || st.reasoning;
      if (st.reasonEl.__getText() !== finalReasoning) st.reasonEl.__setText(finalReasoning);
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
    // 回答被截断/切断时：当场提示，并挂上「接着写」
    if (ev.type === 'done' && (ev.truncated || ev.endedEarly) && st.el) {
      const local = conv ? conv.messages.find((x) => x.id === st.messageId) : null;
      const box = truncationNoticeEl(local || { truncated: ev.truncated, endedEarly: ev.endedEarly, finishReason: ev.finishReason });
      if (box) st.el.appendChild(box);
      toast(ev.endedEarly ? '这条回答可能是被中途切断的（接口没有给出结束原因）'
        : '这条回答达到输出长度上限被截断了，可调大「最大输出 tokens」或点「接着写」');
      scheduleContextInfo(0);
    }
  }

  if (ev.title && conv) {
    conv.title = ev.title;
    if (conv.id === currentId) el.title.value = ev.title;
  }

  streaming = null;
  updateSendButton();
  renderSidebar();
  if (ev.type === 'error') toast('生成失败：' + (ev.error || ''), true);
  if (ev.thinkingSkipped) {
    toast('这个模型/接口不接受思考参数，已自动去掉后重试（本次没有思考过程）');
  }
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
          const res = await api.fetchModels(conn.id);
          conn.models = res.models;
          conn.modelsFetchedAt = res.fetchedAt;
          dl.innerHTML = res.models.map((id) => '<option value="' + esc(id) + '"></option>').join('');
          toast(res.count
            ? `获取到 ${res.count} 个模型，点模型输入框可下拉选择，顶栏也能直接切换`
            : '接口没有返回模型列表');
          if (modelPicker) modelPicker.reload();
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
  reasonText.textContent = '显示模型的思考过程（同时会主动向 Claude / Gemini 索取思考，会多消耗一些 token）';
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

  // 最大输出 tokens：0 = 不限制（交给接口自己的默认值）
  const maxOut = inputEl('number', S.settings.defaultMaxTokens || 0);
  maxOut.min = '0';
  maxOut.step = '256';
  const maxOutField = field('默认最大输出 tokens', maxOut);
  const maxOutHint = document.createElement('div');
  maxOutHint.className = 'sub';
  maxOutHint.textContent = '0 = 不限制（用接口自己的默认值）。想省 token、或者怕回答太长被截断，可以填一个数，' +
    '例如 4096 / 8192。Claude 的接口要求必须带这个值，留空时程序用 8192。' +
    '单个对话可以在「对话参数」里单独覆盖。';
  maxOutField.appendChild(maxOutHint);
  pane.appendChild(maxOutField);
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
      defaultMaxTokens: Math.max(0, Math.floor(Number(maxOut.value) || 0)),
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

  // 自动备份：每次启动都会把上一份数据留下来，这里可以看清单并一键恢复
  const backupsBtn = document.createElement('button');
  backupsBtn.className = 'ghost-btn';
  backupsBtn.textContent = '自动备份…';
  backupsBtn.title = '查看程序自动留存的历史数据快照，可一键恢复';
  backupsBtn.addEventListener('click', openBackups);

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
  backupTip.textContent = '数据每次启动都会自动留一份快照（见「自动备份…」），' +
    '「导出全部数据」则是存一份到你指定的地方。导出的 JSON 是纯文本、含 API Key，别外传。';
  actions.appendChild(save);
  actions.appendChild(openDir);
  actions.appendChild(backupBtn);
  actions.appendChild(restoreBtn);
  actions.appendChild(backupsBtn);
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
  // 最大输出：0 = 跟随全局默认/接口默认
  const maxOut = inputEl('number', typeof conv.maxTokens === 'number' ? conv.maxTokens : 0);
  maxOut.min = '0';
  maxOut.step = '256';
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

  // 模型也用下拉：这里只记下选择，点保存才真正生效
  let pendingModel = conv.model || '';
  const modelBox = document.createElement('div');
  modelBox.className = 'field';
  const modelLabel = document.createElement('label');
  modelLabel.textContent = '模型';
  modelBox.appendChild(modelLabel);
  const modelHost = document.createElement('div');
  modelBox.appendChild(modelHost);
  const modelSub = document.createElement('div');
  modelSub.className = 'sub';
  modelSub.textContent = '从下拉里选，或直接输入模型名；选「用接口默认」则不覆盖接口设置';
  modelBox.appendChild(modelSub);

  createModelPicker(modelHost, {
    getContext: () => {
      const conn = S.connections.find((c) => c.id === (connSel.value || conv.connectionId)) || null;
      return {
        connectionId: conn ? conn.id : null,
        conversationId: conv.id,
        model: pendingModel,
        connModel: conn ? conn.model || '' : '',
      };
    },
    onPick: (m) => { pendingModel = m; },
  });

  body.appendChild(field('系统提示词（只影响这个对话）', sys));
  const row = document.createElement('div');
  row.className = 'row';
  row.appendChild(field('温度', temp, '越高越随机，0 最确定'));
  row.appendChild(field('最大输出 tokens', maxOut,
    '0 = 跟随全局默认；填了就只影响这个对话（例如 4096）'));
  body.appendChild(row);
  const row2 = document.createElement('div');
  row2.className = 'row';
  row2.appendChild(field('接口', connSel));
  body.appendChild(row2);
  body.appendChild(modelBox);
  connSel.addEventListener('change', () => {
    pendingModel = '';
    const host = $('.mp-label', modelHost);
    if (host) host.textContent = '接口默认';
  });

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
      maxTokens: Math.max(0, Math.floor(Number(maxOut.value) || 0)),
      model: pendingModel,
      connectionId: connSel.value || conv.connectionId,
    };
    Object.assign(conv, patch);
    await api.updateConversation(conv.id, patch);
    if (modelPicker) modelPicker.reload();
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
