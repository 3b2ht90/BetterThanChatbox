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
const localfs = require('./lib/localfs');
const datadir = require('./lib/datadir');

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

// 启动时的严重问题（比如数据目录被换掉了），要在窗口出来后明确告诉用户
let startupWarning = '';

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

  const picked = datadir.pickDataDir(candidates, isWritableDir);
  if (process.env.BTC_SMOKE) {
    for (const c of picked.scored || []) {
      console.log('[main] 候选数据目录: ' + c.dir + '  数据分=' + c.score + '  可写=' + c.writable);
    }
  }
  if (picked.warning) {
    startupWarning = picked.warning;
    if (process.env.BTC_SMOKE) console.log('[main] 数据目录不可写，已搬到: ' + picked.movedTo);
  } else if (process.env.BTC_SMOKE) {
    console.log('[main] 使用数据目录: ' + picked.dir + '（数据分 ' + picked.score + '）');
  }
  return picked.dir;
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
    // 数据目录被换掉这种事必须让用户看到，不然他会以为对话被删了
    readWarning: [startupWarning, store.readWarning].filter(Boolean).join('\n\n') || null,
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

  // ---------------- 本地路径读取 ----------------

  // 探测文本里的本机路径（只列清单，不读正文，快）
  ipcMain.handle('path:probe', (_e, { text }) => {
    try {
      return localfs.probeText(text || '');
    } catch (err) {
      return { items: [], error: String(err.message || err) };
    }
  });

  // 把探测到的路径变成真正的附件（文件夹只存路径+清单，单个文件按普通附件处理）
  ipcMain.handle('path:attach', (_e, { paths }) => {
    const out = [];
    for (const p of paths || []) {
      try {
        const item = localfs.describePath(p);
        if (!item) { out.push({ error: '路径不存在', path: p }); continue; }
        if (item.kind === 'blocked') { out.push({ error: item.warning, path: p }); continue; }
        if (item.kind === 'folder') { out.push(localfs.folderToAttachment(item)); continue; }
        // 单个文件：跟拖进来的文件走同一条路（复制进数据目录并提取正文）
        const buf = fs.readFileSync(item.path);
        out.push(saveAttachment(item.name, '', buf));
      } catch (err) {
        out.push({ error: String(err.message || err), path: p });
      }
    }
    return out;
  });

  // 把一条 AI 回复保存成本地文件（默认落到这条消息里带的那个文件夹）
  ipcMain.handle('msg:save', async (_e, { conversationId, messageId, defaultDir }) => {
    const conv = store.getConversation(conversationId);
    if (!conv) throw new Error('对话不存在');
    const msg = (conv.messages || []).find((m) => m.id === messageId);
    if (!msg) throw new Error('消息不存在');
    const content = String(msg.content || '').trim();
    if (!content) throw new Error('这条消息没有内容可保存');

    // 目标文件夹：从这条消息往前找最近一条带文件夹附件的消息
    // （文件夹是挂在「用户提问」上的，AI 回复自己没有附件）
    const msgs = conv.messages || [];
    const idx = msgs.findIndex((m) => m.id === messageId);
    let folderAtt = null;
    for (let i = (idx >= 0 ? idx : msgs.length - 1); i >= 0; i--) {
      const hit = (msgs[i].attachments || []).find((a) => a && a.kind === 'folder' && a.path);
      if (hit) { folderAtt = hit; break; }
    }
    let baseDir = folderAtt ? folderAtt.path : (defaultDir || '');
    if (baseDir && !fs.existsSync(baseDir)) baseDir = '';

    // 文件名：优先用正文里第一个标题，其次用对话标题
    const heading = /^\s*#{1,3}\s+(.+)$/m.exec(content);
    const stamp = new Date().toISOString().slice(0, 10);
    const stem = exporter.safeFileName(
      String(heading ? heading[1] : conv.title || '总结').replace(/[#*`]/g, '').trim() || '总结',
      '总结'
    ).slice(0, 40);
    const defaultPath = path.join(baseDir || app.getPath('documents'), `${stem}-${stamp}.md`);

    const result = await dialog.showSaveDialog(win, {
      title: folderAtt ? `保存到 ${path.basename(folderAtt.path)}` : '保存为本地文件',
      defaultPath,
      filters: [
        { name: 'Markdown 文档', extensions: ['md'] },
        { name: '纯文本', extensions: ['txt'] },
      ],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return { canceled: true };

    fs.writeFileSync(result.filePath, content + '\n', 'utf8');
    return {
      canceled: false,
      path: result.filePath,
      dir: path.dirname(result.filePath),
      bytes: Buffer.byteLength(content, 'utf8') + 1,
    };
  });

  // ---------------- 导入对话 ----------------

  // 从导出的 JSON / Markdown / 整库备份里导入对话（追加，不覆盖现有对话）
  ipcMain.handle('conv:import', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择要导入的文件（本软件导出的 JSON / Markdown，或整库备份）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '对话 / 备份文件', extensions: ['json', 'md', 'markdown', 'txt'] },
        { name: 'JSON', extensions: ['json'] },
        { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };

    const picked = [];
    const errors = [];
    let totalMessages = 0;
    for (const file of result.filePaths) {
      const parsed = exporter.readImportFile(file, { exists: (p) => fs.existsSync(p) });
      if (!parsed.ok) { errors.push(path.basename(file) + '：' + parsed.error); continue; }
      picked.push({ file, parsed });
      for (const c of parsed.conversations) totalMessages += (c.messages || []).length;
    }
    if (!picked.length) {
      return { canceled: false, imported: 0, errors, error: errors[0] || '没有可导入的内容' };
    }

    // 虽然导入只追加，还是先把当前数据另存一份，出了意外有退路
    const backupPath = store.backupCurrentFile();

    const detailLines = picked.map((p) => {
      const label = p.parsed.kind === 'backup' ? '整库备份'
        : p.parsed.kind === 'markdown' ? 'Markdown' : '对话文件';
      return `· ${path.basename(p.file)}（${label}）→ ${p.parsed.count} 个对话` +
        (p.parsed.kind === 'markdown' && !p.parsed.parsed ? '（没认出分段结构，整篇作为一条消息）' : '');
    });
    const missingAtts = picked.reduce((n, p) => n +
      p.parsed.conversations.reduce((k, c) => k +
        (c.messages || []).reduce((j, m) => j +
          (m.attachments || []).filter((a) => a.missing).length, 0), 0), 0);
    const totalConvs = picked.reduce((n, p) => n + p.parsed.count, 0);

    const confirm = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['取消', '导入'],
      defaultId: 1,
      cancelId: 0,
      title: '确认导入',
      message: `会把这些文件里的 ${totalConvs} 个对话（共 ${totalMessages} 条消息）添加进来。`,
      detail: detailLines.join('\n') +
        '\n\n导入是「追加」：现有对话不会被改动。' +
        (missingAtts ? `\n其中 ${missingAtts} 个附件是别的电脑上的文件，本机找不到原文件，只保留名字。` : '') +
        '\n（导入前已自动把当前数据另存一份）',
      noLink: true,
    });
    if (confirm.response !== 1) return { canceled: true };

    const all = [];
    for (const p of picked) all.push(...p.parsed.conversations);
    const added = store.importConversations(all);

    return {
      canceled: false,
      imported: added.length,
      messages: totalMessages,
      missingAtts,
      backupPath,
      errors,
      conversations: added.map((c) => ({ id: c.id, title: c.title, messages: (c.messages || []).length })),
    };
  });

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

  // 自动备份：列出 / 恢复（用户不需要记得手动备份）
  ipcMain.handle('data:backups', () => ({ list: store.listBackups(), dir: store.backupDir }));

  ipcMain.handle('data:restoreBackup', async (_e, { name }) => {
    const backups = store.listBackups();
    const target = backups.find((b) => b.name === name);
    if (!target) throw new Error('找不到这份备份');
    const confirm = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['取消', '恢复这份备份'],
      defaultId: 1,
      cancelId: 0,
      title: '恢复自动备份',
      message: '要用这份备份替换当前的数据吗？',
      detail: `备份时间：${new Date(target.mtime).toLocaleString()}\n` +
        `其中含：接口 ${target.counts ? target.counts.connections : '?'} 个、` +
        `对话 ${target.counts ? target.counts.conversations : '?'} 个、` +
        `消息 ${target.counts ? target.counts.messages : '?'} 条\n\n` +
        '当前的数据会先被自动留一份，不会丢。',
      noLink: true,
    });
    if (confirm.response !== 1) return { canceled: true };
    const counts = store.restoreBackup(name);
    return { canceled: false, counts, dir: store.backupDir };
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
          // 最大输出 tokens：对话里设了就用对话的，否则用全局默认；0 = 不限制
          maxTokens: typeof conv.maxTokens === 'number' && conv.maxTokens > 0
            ? conv.maxTokens
            : (Number(store.state.settings.defaultMaxTokens) || 0),
          messages: history,
          signal: controller.signal,
          // 主动向接口索要思考过程（Claude / Gemini 不主动要就一个字都不给）
          thinking: { enabled: store.state.settings.showReasoning !== false },
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
          thinkingSkipped: !!result.thinkingSkipped,
        });
      } catch (err) {
        if (flushTimer) clearTimeout(flushTimer);
        const aborted = controller.signal.aborted;
        // 这里必须过一遍 friendlyError：
        // 流式中途断开时 undici 抛的是 `terminated` / `other side closed` 这种原始英文，
        // 以前会原样显示成「⚠️ terminated」，用户根本看不出发生了什么。
        const message = aborted
          ? '已停止生成'
          : providers.friendlyError(err, { gotContent: !!text }).message;
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
  // 千万不能 app.quit()（退出码 0）—— 启动器会把「1.5 秒内以 0 退出」当成启动成功，
  // 于是既不再试别的参数、也不弹任何提示，用户看到的就是「双击毫无反应」。
  // 这里用专门的退出码把两种原因分开告诉启动器：
  //   3 = 真有一个实例在跑（让启动器去前台化，别当失败）
  //   4 = 数据目录写不进去（锁文件建不了），这是环境问题，得让启动器重定向数据目录
  const writable = isWritableDir(userDataDir);
  if (process.env.BTC_SMOKE) {
    console.log('[main] 拿不到单实例锁；数据目录可写=' + writable + '，退出码 ' + (writable ? 3 : 4));
  }
  app.exit(writable ? 3 : 4);
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
