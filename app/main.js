'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const { Store } = require('./lib/store');
const attachments = require('./lib/attachments');
const md = require('./lib/markdown');
const providers = require('./lib/providers');
const exporter = require('./lib/exporter');
const modelOptions = require('./lib/modelOptions');

const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;

// ---------------- 应用图标 ----------------
// 由 scripts/make-icon.cjs 用 Electron 离屏渲染生成（深绿方块 + 米色 BetterThanChatbox），
// 开发模式与打包后都在同一相对位置：<项目根>/assets/icon.ico
const ICON_ICO = path.join(__dirname, '..', 'assets', 'icon.ico');
const WINDOW_ICON = fs.existsSync(ICON_ICO) ? ICON_ICO : undefined;

// ---------------- 数据目录 ----------------
// 默认还是 %APPDATA%\BetterThanChatbox（老用户的数据在这里，优先用它）。
// 但如果那里不可写（受限环境、便携盘、只读目录），依次退到：
//   程序目录\data  →  程序运行时目录\data  →  临时目录\BetterThanChatbox
// 否则连 store 都建不出来，双击之后什么都看不到。
function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (err) {
    return false;
  }
}

function pickUserDataDir() {
  // 自动化测试指定了目录就用它
  if (process.env.BTC_USER_DATA) return process.env.BTC_USER_DATA;
  const appHome = process.env.BTC_APP_HOME; // 启动器传进来的程序根目录
  const candidates = [
    path.join(app.getPath('appData'), 'BetterThanChatbox'),
    appHome ? path.join(appHome, 'data') : null,
    path.join(path.dirname(process.execPath), 'data'),
    path.join(app.getPath('temp'), 'BetterThanChatbox'),
  ].filter(Boolean);

  // 第一优先：已经有数据的目录。
  // 为什么重要：%APPDATA% 能不能写会随环境变化（受限环境里不可写 → 数据落到程序目录\data，
  // 下次正常双击又变得可写 → 如果只看"谁先可写"就会换目录，用户会以为数据丢了）。
  // 所以只要某个候选目录里已经存在 data.json，就一直用它。
  for (const dir of candidates) {
    try {
      const f = path.join(dir, 'data.json');
      if (fs.existsSync(f) && fs.statSync(f).size > 2) {
        if (process.env.BTC_SMOKE) console.log('[main] 沿用已有数据的目录: ' + dir);
        return dir;
      }
    } catch { /* 忽略，继续找 */ }
  }

  for (const dir of candidates) {
    if (isWritableDir(dir)) return dir;
  }
  return candidates[0];
}

const userDataDir = pickUserDataDir();
try {
  app.setPath('userData', userDataDir);
  fs.mkdirSync(userDataDir, { recursive: true }); // Electron 的 crashpad 等也会用到这个目录
  if (process.env.BTC_SMOKE) console.log('[main] 数据目录: ' + userDataDir);
} catch (err) {
  console.error('[main] 设置数据目录失败:', err);
}

let win = null;
let store = null;
const streams = new Map();

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------- 主题 ----------------

// 窗口底色，避免加载瞬间闪出另一种颜色
const THEME_BG = { dark: '#0b1210', light: '#f8f5ed' };

// 把设置里的主题（system / light / dark）映射成实际生效的 light / dark
function resolveTheme(theme) {
  const t = theme || 'system';
  if (t === 'light' || t === 'dark') return t;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

// 同步给 Electron：窗口外框、菜单、滚动条等跟随主题
function applyNativeTheme(theme) {
  const t = theme === 'light' || theme === 'dark' ? theme : 'system';
  nativeTheme.themeSource = t;
  if (win && !win.isDestroyed()) win.setBackgroundColor(THEME_BG[resolveTheme(t)]);
}

function buildAttachmentMeta(info, buffer) {
  const text = attachments.extractText(buffer, info);
  return {
    id: crypto.randomUUID(),
    name: info.name,
    ext: info.ext,
    kind: info.kind,
    mime: info.mime,
    size: buffer.length,
    path: info.storedPath,
    url: pathToFileURL(info.storedPath).href,
    text: info.kind === 'image' ? '' : text,
    hasText: info.kind === 'image' ? false : Boolean(text),
  };
}

function saveAttachment(name, mime, buffer) {
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`文件过大（${(buffer.length / 1048576).toFixed(1)} MB），单个附件上限 30 MB`);
  }
  const info = attachments.classify(name, mime);
  const saved = store.saveAttachmentFromBuffer(name, info.mime, buffer);
  return buildAttachmentMeta({ ...saved, ...info, name }, buffer);
}

function createWindow() {
  // 首屏防闪：把已经定好的主题通过启动参数交给 preload，
  // preload 会在页面绘制前就把 data-theme 写到 <html> 上。
  const theme = (store && store.state.settings.theme) || 'system';
  applyNativeTheme(theme);

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 780,
    minHeight: 520,
    backgroundColor: THEME_BG[resolveTheme(theme)],
    title: 'BetterThanChatbox',
    icon: WINDOW_ICON,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      additionalArguments: ['--btc-theme=' + resolveTheme(theme)],
    },
  });

  if (process.env.BTC_SMOKE) {
    globalThis.__smokeLogs = globalThis.__smokeLogs || [];
    win.webContents.on('console-message', (_event, level, message, line, source) => {
      const text = `[renderer:${level}] ${message} (${path.basename(String(source))}:${line})`;
      globalThis.__smokeLogs.push(text);
      console.log(text);
    });
  }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  win.on('closed', () => {
    win = null;
    for (const ctrl of streams.values()) {
      try { ctrl.abort(); } catch { /* ignore */ }
    }
    streams.clear();
  });
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建对话',
          accelerator: 'CmdOrCtrl+N',
          click: () => send('menu:action', { action: 'new-conversation' }),
        },
        {
          label: '设置',
          accelerator: 'CmdOrCtrl+,',
          click: () => send('menu:action', { action: 'open-settings' }),
        },
        { type: 'separator' },
        { label: '打开数据目录', click: () => shell.openPath(app.getPath('userData')) },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.handle('store:get', () => ({
    ...store.state,
    readWarning: store.readWarning || null,
    appInfo: {
      version: app.getVersion(),
      dataDir: app.getPath('userData'),
      electron: process.versions.electron,
      node: process.versions.node,
    },
  }));

  ipcMain.handle('store:settings', (_e, patch) => {
    const settings = store.updateSettings(patch);
    if (patch && patch.theme) applyNativeTheme(settings.theme);
    return settings;
  });

  // preload 在页面脚本之前同步取一次主题，避免首屏闪色
  ipcMain.on('theme:current', (event) => {
    event.returnValue = resolveTheme(store.state.settings.theme);
  });

  ipcMain.handle('conn:add', (_e, data) => {
    const conn = store.addConnection(data || {});
    return conn;
  });
  ipcMain.handle('conn:update', (_e, { id, patch }) => store.updateConnection(id, patch));
  ipcMain.handle('conn:delete', (_e, { id }) => {
    store.deleteConnection(id);
    return true;
  });
  ipcMain.handle('conn:active', (_e, { id }) => {
    store.setActiveConnection(id);
    return true;
  });

  ipcMain.handle('conv:create', (_e, opts) => store.createConversation(opts || {}));
  ipcMain.handle('conv:update', (_e, { id, patch }) => store.updateConversation(id, patch));
  ipcMain.handle('conv:delete', (_e, { id }) => store.deleteConversation(id));

  ipcMain.handle('msg:append', (_e, { conversationId, message }) => store.appendMessage(conversationId, message || {}));
  ipcMain.handle('msg:update', (_e, { conversationId, messageId, patch }) =>
    store.updateMessage(conversationId, messageId, patch));
  ipcMain.handle('msg:delete', (_e, { conversationId, messageId }) => store.deleteMessage(conversationId, messageId));

  ipcMain.handle('md:render', (_e, { text }) => md.render(text));

  // ---------------- 导出 ----------------

  // 导出单个对话：按用户在保存对话框里选的扩展名决定 Markdown 还是 JSON
  ipcMain.handle('conv:export', async (_e, { conversationId }) => {
    const conv = store.getConversation(conversationId);
    if (!conv) throw new Error('对话不存在');
    const conn = store.getConnection(conv.connectionId);
    const ctx = {
      appVersion: app.getVersion(),
      connectionName: conn ? conn.name : '',
      connectionType: conn ? conn.type : '',
      defaultModel: conn ? conn.model : '',
    };
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(win, {
      title: '导出对话',
      defaultPath: path.join(app.getPath('documents'), `${exporter.safeFileName(conv.title)}-${stamp}.md`),
      filters: [
        { name: 'Markdown 文档', extensions: ['md'] },
        { name: 'JSON（含全部版本，可再导入）', extensions: ['json'] },
        { name: '纯文本', extensions: ['txt'] },
      ],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return { canceled: true };

    const written = exporter.writeConversationFile(result.filePath, conv, ctx);
    return {
      canceled: false,
      path: written.path,
      format: written.format,
      bytes: written.bytes,
      messages: (conv.messages || []).length,
    };
  });

  // 导出全部数据（含接口配置，是敏感文件）
  ipcMain.handle('data:backup', async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const result = await dialog.showSaveDialog(win, {
      title: '导出全部数据（含接口配置与 API Key）',
      defaultPath: path.join(app.getPath('documents'), `BetterThanChatbox-备份-${stamp}.json`),
      filters: [{ name: 'JSON 备份', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const written = exporter.writeBackupFile(result.filePath, store.state, app.getVersion());
    return {
      canceled: false,
      path: written.path,
      bytes: written.bytes,
      counts: written.counts,
    };
  });

  // 导入备份（整体替换；导入前先把现有数据另存一份）
  ipcMain.handle('data:restore', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择备份文件（会覆盖当前全部对话与接口配置）',
      properties: ['openFile'],
      filters: [{ name: 'JSON 备份', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };

    const file = result.filePaths[0];
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error('读取备份文件失败：' + err.message);
    }
    const parsed = exporter.parseBackup(text);
    if (!parsed.ok) throw new Error(parsed.error);

    const confirm = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['取消', '确定导入'],
      defaultId: 0,
      cancelId: 0,
      title: '确认导入',
      message: '导入会用备份里的内容覆盖当前的对话和接口配置。',
      detail: `备份文件：${path.basename(file)}\n` +
        `备份时间：${exporter.fmtTime(parsed.data.exportedAt)}\n` +
        `包含：${(parsed.data.connections || []).length} 个接口、` +
        `${(parsed.data.conversations || []).length} 个对话\n\n` +
        '当前数据会先自动另存一份（data.json.bak-…），导入后需要重启软件才会完全生效。',
      noLink: true,
    });
    if (confirm.response !== 1) return { canceled: true };

    const backupPath = store.backupCurrentFile();
    const counts = store.importState(parsed.data);
    const fresh = store.state;
    // 兜底：导入的 activeConnectionId 必须真实存在
    if (!store.getConnection(fresh.activeConnectionId)) {
      store.setActiveConnection(fresh.connections[0] ? fresh.connections[0].id : null);
    }
    return { canceled: false, counts, backupPath, path: file };
  });

  // 选择本地文件
  ipcMain.handle('att:pick', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择要发送的文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '所有文件', extensions: ['*'] },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
        { name: '文本', extensions: ['txt', 'md', 'json', 'csv', 'log', 'js', 'ts', 'py', 'html', 'css'] },
        { name: 'Office 文档', extensions: ['docx', 'xlsx', 'pptx'] },
        { name: 'PDF', extensions: ['pdf'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return [];
    const out = [];
    for (const p of result.filePaths) {
      try {
        const buf = fs.readFileSync(p);
        out.push(saveAttachment(path.basename(p), '', buf));
      } catch (err) {
        out.push({ error: String(err.message || err), name: path.basename(p) });
      }
    }
    return out;
  });

  // 拖拽 / 粘贴进来的文件（base64）
  ipcMain.handle('att:save', (_e, { name, mime, base64 }) => {
    const buf = Buffer.from(String(base64 || ''), 'base64');
    return saveAttachment(name || 'file', mime || '', buf);
  });

  ipcMain.handle('att:open', (_e, { path: p }) => {
    if (p && fs.existsSync(p)) return shell.openPath(p);
    return '文件不存在';
  });

  ipcMain.handle('att:copyImage', (_e, { path: p }) => {
    try {
      if (p && fs.existsSync(p)) {
        clipboard.writeImage(require('electron').nativeImage.createFromPath(p));
        return true;
      }
    } catch { /* ignore */ }
    return false;
  });

  // 只读：拿下拉列表要显示的内容（不联网），用于打开界面/切接口时立刻渲染
  ipcMain.handle('models:suggest', (_e, { connectionId, conversationId }) => {
    const conn = store.getConnection(connectionId)
      || store.getConnection(store.state.activeConnectionId);
    if (!conn) return { groups: [], fetchedAt: null, hasCache: false };
    const conv = conversationId ? store.getConversation(conversationId) : null;
    return modelOptions.suggestModels(store.state, conn, conv ? conv.model : '');
  });

  // 联网拉取模型列表，并缓存到接口配置里（下次打开不用再等网络）
  ipcMain.handle('models:fetch', async (_e, { connectionId }) => {
    const conn = store.getConnection(connectionId);
    if (!conn) throw new Error('接口配置不存在');
    const list = await providers.listModels(conn);
    const models = modelOptions.normalizeFetched(list);
    const fetchedAt = new Date().toISOString();
    store.updateConnection(conn.id, { models, modelsFetchedAt: fetchedAt });
    return { models, fetchedAt, count: models.length };
  });

  // 兼容旧调用：只要一个模型名数组
  ipcMain.handle('models:list', async (_e, { connectionId }) => {
    const conn = store.getConnection(connectionId);
    if (!conn) throw new Error('接口配置不存在');
    return providers.listModels(conn);
  });

  ipcMain.handle('app:openExternal', (_e, { url }) => {
    if (/^https?:/i.test(url)) return shell.openExternal(url);
    return false;
  });
  ipcMain.handle('app:openDataDir', () => shell.openPath(app.getPath('userData')));

  ipcMain.handle('chat:stop', (_e, { streamId }) => {
    const ctrl = streams.get(streamId);
    if (ctrl) {
      ctrl.abort();
      return true;
    }
    return false;
  });

  // 接口：优先用对话自己绑定的，其次是全局当前接口
  function resolveConnection(conv) {
    let conn = store.getConnection(conv.connectionId);
    if (!conn) conn = store.getConnection(store.state.activeConnectionId);
    if (!conn) throw new Error('还没有配置接口。点击左下角「设置」添加一个 API 接口。');
    if (!conv.connectionId) store.updateConversation(conv.id, { connectionId: conn.id });
    return conn;
  }

  // 拼上下文：beforeMessageId 之前的消息（不含它自己）；不传就是全部。
  // 「重新回答」走这条，保证模型看不到被重新回答的那条及其后面的内容。
  function buildHistory(conv, beforeMessageId) {
    const usable = conv.messages.filter((m) => !m.error);
    let list = usable;
    if (beforeMessageId) {
      const cut = usable.findIndex((m) => m.id === beforeMessageId);
      list = cut >= 0 ? usable.slice(0, cut) : usable;
    }
    const limit = Math.max(2, Number(store.state.settings.historyLimit) || 30);
    return list.slice(-limit);
  }

  // 发送与重新回答共用的流式过程。
  // target.messageId 有值 = 往那条消息追加一个新版本（旧版本保留）；否则新建一条回答。
  function runStream({ conv, conn, streamId, history, target }) {
    let placeholder;
    let variantIndex = null;
    if (target && target.messageId) {
      const added = store.addVariant(conv.id, target.messageId, {});
      if (!added) throw new Error('要重新回答的消息不存在');
      placeholder = added.message;
      variantIndex = added.variantIndex;
    } else {
      placeholder = store.appendMessage(conv.id, { role: 'assistant', content: '' });
    }
    const controller = new AbortController();
    streams.set(streamId, controller);

    send('chat:event', {
      streamId,
      type: 'start',
      conversationId: conv.id,
      messageId: placeholder.id,
      variantIndex,
    });

    (async () => {
      let text = '';
      let reasoning = '';
      let pending = '';
      let flushTimer = null;
      const flush = () => {
        flushTimer = null;
        if (pending) {
          send('chat:event', { streamId, type: 'delta', text: pending, reasoning: '' });
          pending = '';
        }
      };
      try {
        const result = await providers.streamChat({
          connection: conn,
          model: conv.model,
          systemPrompt: conv.systemPrompt,
          temperature: typeof conv.temperature === 'number' ? conv.temperature : undefined,
          messages: history,
          signal: controller.signal,
          onDelta: (chunk) => {
            text += chunk;
            pending += chunk;
            if (!flushTimer) flushTimer = setTimeout(flush, 50);
          },
          onReasoning: (chunk) => {
            reasoning += chunk;
            send('chat:event', { streamId, type: 'reasoning', text: chunk });
          },
        });
        if (flushTimer) clearTimeout(flushTimer);
        pending = '';
        const saved = store.updateMessage(conv.id, placeholder.id, {
          content: result.text || text,
          reasoning: result.reasoning || reasoning,
        });
        const updatedConv = store.getConversation(conv.id);
        send('chat:event', {
          streamId,
          type: 'done',
          conversationId: conv.id,
          message: saved,
          title: updatedConv ? updatedConv.title : conv.title,
        });
      } catch (err) {
        if (flushTimer) clearTimeout(flushTimer);
        const aborted = controller.signal.aborted;
        const message = aborted ? '已停止生成' : String((err && err.message) || err);
        const saved = store.updateMessage(conv.id, placeholder.id, {
          content: text,
          reasoning,
          error: message,
        });
        send('chat:event', {
          streamId,
          type: aborted ? 'stopped' : 'error',
          conversationId: conv.id,
          message: saved,
          error: message,
        });
      } finally {
        streams.delete(streamId);
      }
    })();

    return { ok: true, messageId: placeholder.id, variantIndex };
  }

  ipcMain.handle('chat:send', async (_e, { conversationId, streamId }) => {
    const conv = store.getConversation(conversationId);
    if (!conv) throw new Error('对话不存在');
    const conn = resolveConnection(conv);
    const history = buildHistory(conv);
    if (!history.length) throw new Error('没有可发送的消息');
    return runStream({ conv, conn, streamId, history });
  });

  // 重新回答：给指定回答追加一个新版本，旧版本保留
  ipcMain.handle('chat:reanswer', async (_e, { conversationId, streamId, messageId }) => {
    const conv = store.getConversation(conversationId);
    if (!conv) throw new Error('对话不存在');
    const target = conv.messages.find((m) => m.id === messageId);
    if (!target) throw new Error('要重新回答的消息不存在');
    if (target.role !== 'assistant') throw new Error('只能对 AI 的回答重新回答');
    const conn = resolveConnection(conv);
    const history = buildHistory(conv, messageId);
    if (!history.length) throw new Error('没有可发送的消息');
    return runStream({ conv, conn, streamId, history, target: { messageId } });
  });

  // 切换消息版本（分支切换）
  ipcMain.handle('msg:variant', (_e, { conversationId, messageId, index }) =>
    store.setActiveVariant(conversationId, messageId, index));

  // 编辑提问：新内容作为该消息的新版本追加，旧提问保留
  ipcMain.handle('msg:branch', (_e, { conversationId, messageId, patch }) =>
    store.addVariant(conversationId, messageId, patch || {}));
}

const gotLock = app.requestSingleInstanceLock();
if (process.env.BTC_SMOKE) {
  // 诊断用：单实例锁拿不到时窗口不会出现（静默退出），必须能查出来
  try {
    fs.writeFileSync(path.join(userDataDir, 'startup-diag.json'), JSON.stringify({
      at: new Date().toISOString(),
      gotLock,
      pid: process.pid,
      userData: app.getPath('userData'),
      appData: app.getPath('appData'),
      env: { APPDATA: process.env.APPDATA, TEMP: process.env.TEMP, BTC_APP_HOME: process.env.BTC_APP_HOME },
      argv: process.argv,
    }, null, 2), 'utf8');
  } catch (err) {
    console.error('[main] 写启动诊断失败:', err);
  }
}
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    store = new Store(app.getPath('userData'));
    registerIpc();
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    if (process.env.BTC_SMOKE_SCRIPT) {
      const driverPath = path.resolve(process.env.BTC_SMOKE_SCRIPT);
      Promise.resolve()
        .then(() => require(driverPath)(win, app))
        .then(() => app.exit(0))
        .catch((err) => {
          console.error('[smoke] 失败:', err);
          app.exit(1);
        });
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (store) store.saveNow();
  });
}
