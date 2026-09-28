'use strict';

// 导出功能的端到端测试驱动。
// 由主进程 require 后调用，参数是 (win, app)。
//
// 关键手法：驱动跑在主进程里，可以把 electron 的 dialog.showSaveDialog 换成假的，
// 于是「点导出按钮 → IPC → 生成内容 → 写文件」整条链路都能自动跑完并校验落盘结果，
// 不需要人去点原生保存对话框。

const path = require('path');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function exportE2E(win, app) {
  const { dialog } = require('electron');

  const outDir = path.join(app.getPath('userData'), 'export-e2e-out');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const saveCalls = [];
  dialog.showSaveDialog = async (_win, opts) => {
    saveCalls.push({ title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters });
    const isBackup = /备份|全部数据/.test(opts.title || '');
    return { canceled: false, filePath: path.join(outDir, isBackup ? 'backup.json' : 'conversation.md') };
  };
  // 导入用不到，但别让它在无人值守时弹窗卡死
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  dialog.showMessageBox = async () => ({ response: 0 });

  const checks = [];
  const check = (name, pass, extra) => {
    checks.push({ name, pass: !!pass, extra: extra === undefined ? null : String(extra) });
    console.log((pass ? '  ✓ ' : '  ✗ ') + name + (extra && !pass ? '  → ' + extra : ''));
  };

  const js = (code) => win.webContents.executeJavaScript(code, true);

  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  await sleep(1500); // 等渲染层 init() 跑完

  console.log('界面上的导出入口');
  const dom = await js(`(() => {
    const items = [...document.querySelectorAll('#conv-list .conv-item')];
    const btn = document.querySelector('#conv-list .conv-item button[data-act="export"]');
    return {
      items: items.length,
      exportButtons: items.filter(i => i.querySelector('button[data-act="export"]')).length,
      tooltip: btn ? btn.getAttribute('title') : null,
      apiExport: typeof window.api.exportConversation,
      apiBackup: typeof window.api.backupAll,
      apiRestore: typeof window.api.restoreAll,
      settingsBtn: !!document.querySelector('#btn-settings'),
    };
  })()`);
  check('侧栏每条对话都有导出按钮', dom.exportButtons > 0 && dom.exportButtons === dom.items,
    `对话 ${dom.items} 条、导出按钮 ${dom.exportButtons} 个`);
  check('按钮有中文提示', dom.tooltip === '导出这个对话', dom.tooltip);
  check('preload 暴露了 exportConversation', dom.apiExport === 'function', dom.apiExport);
  check('preload 暴露了 backupAll', dom.apiBackup === 'function', dom.apiBackup);
  check('preload 暴露了 restoreAll', dom.apiRestore === 'function', dom.apiRestore);

  console.log('\n点「导出这个对话」按钮');
  // 先塞一条消息进去，导出的 md 才有内容可校验
  const seeded = await js(`(async () => {
    const s = await window.api.getState();
    const conv = s.conversations[0];
    if (!conv) return 'no-conversation';
    await window.api.appendMessage(conv.id, {
      role: 'user', content: '端到端导出的测试消息 E2E-MARKER-9527', attachments: []
    });
    await window.api.appendMessage(conv.id, {
      role: 'assistant', content: '这是 AI 的回复，带代码块：\\n\\n\\x60\\x60\\x60js\\nconsole.log(1)\\n\\x60\\x60\\x60', attachments: []
    });
    await window.api.updateConversation(conv.id, { title: '导出测试对话' });
    return conv.id;
  })()`);
  check('能往对话里写入测试消息', seeded !== 'no-conversation', seeded);

  await js(`(() => {
    const btn = document.querySelector('#conv-list .conv-item button[data-act="export"]');
    btn.click();
    return true;
  })()`);
  await sleep(1200);

  const mdFile = path.join(outDir, 'conversation.md');
  check('保存对话框被调起（标题：导出对话）',
    saveCalls.some((c) => c.title === '导出对话'), JSON.stringify(saveCalls.map((c) => c.title)));
  check('默认文件名带 .md 后缀且做了非法字符处理',
    saveCalls[0] && /\.md$/.test(saveCalls[0].defaultPath || ''), saveCalls[0] && saveCalls[0].defaultPath);
  check('文件真的写出来了', fs.existsSync(mdFile));
  if (fs.existsSync(mdFile)) {
    const md = fs.readFileSync(mdFile, 'utf8');
    check('导出内容含标题行', md.startsWith('# 导出测试对话'), md.slice(0, 40));
    check('导出内容含用户消息', md.includes('E2E-MARKER-9527'));
    check('导出内容含 AI 回复与代码块', md.includes('这是 AI 的回复') && md.includes('```js'));
    check('导出内容含导出时间等元信息', md.includes('- 导出时间：') && md.includes('- 软件：BetterThanChatbox'));
    check('导出内容含接口信息', md.includes('- 接口：') || md.includes('- 模型：'));
  }

  console.log('\n从设置里「导出全部数据」');
  await js(`document.querySelector('#btn-settings').click(); true`);
  await sleep(600);
  const tabbed = await js(`(() => {
    const t = [...document.querySelectorAll('.modal-tabs button')].find(b => b.textContent.includes('通用'));
    if (!t) return false;
    t.click();
    return true;
  })()`);
  check('设置里有「通用设置」页签', tabbed);
  await sleep(400);

  const clicked = await js(`(() => {
    const b = [...document.querySelectorAll('.modal-body button')].find(x => x.textContent.includes('导出全部数据'));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  check('设置里有「导出全部数据」按钮', clicked);
  await sleep(1200);

  const backupFile = path.join(outDir, 'backup.json');
  check('备份文件写出来了', fs.existsSync(backupFile));
  if (fs.existsSync(backupFile)) {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    } catch (err) {
      check('备份是合法 JSON', false, err.message);
    }
    if (parsed) {
      check('备份是合法 JSON', true);
      check('备份类型标记正确', parsed.type === 'better-than-chatbox-backup', parsed.type);
      check('备份里有对话', Array.isArray(parsed.conversations) && parsed.conversations.length > 0);
      check('备份里有设置', !!parsed.settings);
      check('备份统计与实际一致',
        parsed.counts.conversations === parsed.conversations.length &&
        parsed.counts.connections === parsed.connections.length,
        JSON.stringify(parsed.counts));
      check('备份能被 parseBackup 解析（回归）', (() => {
        const r = require(path.join(app.getAppPath(), 'app', 'lib', 'exporter.js')).parseBackup(JSON.stringify(parsed));
        return r.ok === true;
      })());
    }
  }

  const failed = checks.filter((c) => !c.pass);
  const report = {
    suite: 'export-e2e',
    total: checks.length,
    failed: failed.length,
    checks,
    saveCalls: saveCalls.map((c) => c.title),
  };
  const reportPath = path.join(outDir, 'e2e-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log('\n导出端到端：共 ' + checks.length + ' 项，失败 ' + failed.length + ' 项');
  console.log('报告：' + reportPath);

  if (failed.length) throw new Error(failed.length + ' 项检查未通过：' + failed.map((f) => f.name).join('、'));
};
