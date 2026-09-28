'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 首屏防闪：在页面脚本执行之前就把主题写到 <html data-theme> 上，
// 否则会先按默认配色画一帧再被 app.js 纠正（浅色用户会看到闪黑）。
// 主题优先向主进程同步要一次（拿到的永远是最新设置），启动参数作为兜底。
(function applyInitialTheme() {
  let theme = '';
  try {
    theme = ipcRenderer.sendSync('theme:current');
  } catch (err) {
    theme = '';
  }
  if (theme !== 'light' && theme !== 'dark') {
    const arg = process.argv.find((a) => a.startsWith('--btc-theme='));
    theme = arg ? arg.slice('--btc-theme='.length) : 'dark';
  }
  if (theme !== 'light' && theme !== 'dark') return;
  const set = () => {
    const root = document.documentElement;
    if (!root) {
      requestAnimationFrame(set);
      return;
    }
    root.dataset.theme = theme;
    root.dataset.themeFrom = 'preload';
  };
  set();
})();

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

const on = (channel, cb) => {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  // 数据
  getState: () => invoke('store:get'),
  updateSettings: (patch) => invoke('store:settings', patch),

  // 接口配置
  addConnection: (data) => invoke('conn:add', data),
  updateConnection: (id, patch) => invoke('conn:update', { id, patch }),
  deleteConnection: (id) => invoke('conn:delete', { id }),
  setActiveConnection: (id) => invoke('conn:active', { id }),
  listModels: (connectionId) => invoke('models:list', { connectionId }),
  suggestModels: (connectionId, conversationId) => invoke('models:suggest', { connectionId, conversationId }),
  fetchModels: (connectionId) => invoke('models:fetch', { connectionId }),

  // 对话
  createConversation: (opts) => invoke('conv:create', opts || {}),
  updateConversation: (id, patch) => invoke('conv:update', { id, patch }),
  deleteConversation: (id) => invoke('conv:delete', { id }),

  // 消息
  appendMessage: (conversationId, message) => invoke('msg:append', { conversationId, message }),
  updateMessage: (conversationId, messageId, patch) => invoke('msg:update', { conversationId, messageId, patch }),
  deleteMessage: (conversationId, messageId) => invoke('msg:delete', { conversationId, messageId }),
  setVariant: (conversationId, messageId, index) => invoke('msg:variant', { conversationId, messageId, index }),
  editMessageBranch: (conversationId, messageId, patch) => invoke('msg:branch', { conversationId, messageId, patch }),

  // 渲染与附件
  renderMarkdown: (text) => invoke('md:render', { text }),
  pickFiles: () => invoke('att:pick'),
  saveAttachment: (payload) => invoke('att:save', payload),
  openAttachment: (p) => invoke('att:open', { path: p }),
  copyImage: (p) => invoke('att:copyImage', { path: p }),

  // 导出 / 备份
  exportConversation: (conversationId) => invoke('conv:export', { conversationId }),
  backupAll: () => invoke('data:backup'),
  restoreAll: () => invoke('data:restore'),

  // 对话流
  sendChat: (conversationId, streamId) => invoke('chat:send', { conversationId, streamId }),
  reanswerChat: (conversationId, streamId, messageId) =>
    invoke('chat:reanswer', { conversationId, streamId, messageId }),
  stopChat: (streamId) => invoke('chat:stop', { streamId }),

  // 其它
  openExternal: (url) => invoke('app:openExternal', { url }),
  openDataDir: () => invoke('app:openDataDir'),

  onChatEvent: (cb) => on('chat:event', cb),
  onMenuAction: (cb) => on('menu:action', cb),
});
