'use strict';

// 「导入对话」的端到端测试驱动。由主进程 require 后调用，参数是 (win, app)。
//
// 覆盖用户实际会走的两种路：
//   A. 应用里点导出（换成假的保存框）→ 数据清空 → 点侧栏「⬆ 导入」→ 选刚导出的文件 → 对话回来了
//   B. 导入一个整库备份文件 → 里面的对话都被追加进来（现有对话不受影响）
//
// 用法见 scripts/run-import-e2e.mjs

const path = require('path');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MARKER = '导入往返测试标记-8821';

module.exports = async function importE2E(win, app) {
  const checks = [];
  const check = (name, pass, extra) => {
    checks.push({ name, pass: !!pass, extra: extra === undefined ? null : String(extra) });
    console.log((pass ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined && !pass ? '  → ' + extra : ''));
  };
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const outDir = path.join(app.getPath('userData'), 'import-e2e-out');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // ---------- 把两个原生对话框换成假的 ----------
  const { dialog } = require('electron');
  const exportPath = path.join(outDir, '往返对话.md');
  const exportJsonPath = path.join(outDir, '往返对话.json');
  const backupImportPath = path.join(outDir, '别人的备份.json');
  let saveCallCount = 0;
  const openCalls = [];

  dialog.showSaveDialog = async (_w, opts) => {
    saveCallCount++;
    const f = /JSON/.test((opts.filters && opts.filters[0] && opts.filters[0].name) || '') ? exportJsonPath : exportPath;
    return { canceled: false, filePath: f };
  };
  // 导入时返回哪个文件由 openCalls 的顺序决定
  let openQueue = [];
  dialog.showOpenDialog = async (_w, opts) => {
    openCalls.push({ title: opts.title });
    const next = openQueue.shift();
    return next ? { canceled: false, filePaths: next } : { canceled: true, filePaths: [] };
  };
  dialog.showMessageBox = async () => ({ response: 1 }); // 确认导入

  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  await sleep(1500);

  try {
    // ---------- 准备一个待导出的对话 ----------
    const seeded = await js(`(async () => {
      const s = await window.api.getState();
      for (const c of s.conversations) await window.api.deleteConversation(c.id);
      const conv = await window.api.createConversation({ title: '往返测试对话' });
      await window.api.appendMessage(conv.id, { role: 'user', content: '这是提问 ' + ${JSON.stringify(MARKER)}, attachments: [] });
      await window.api.appendMessage(conv.id, { role: 'assistant', content: '## 回答标题\\n\\n这是回答内容，带 **粗体**。', attachments: [] });
      return conv.id;
    })()`);
    check('准备好了待导出的对话', !!seeded);

    win.webContents.reload();
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await sleep(1600);

    console.log('\nA. 导出 → 清空 → 导入');
    const domBefore = await js(`(() => ({
      hasImportBtn: !!document.querySelector('#btn-import'),
      importLabel: document.querySelector('#btn-import') ? document.querySelector('#btn-import').textContent.trim() : null,
      importTitle: document.querySelector('#btn-import') ? document.querySelector('#btn-import').getAttribute('title') : null,
      convCount: document.querySelectorAll('#conv-list .conv-item').length,
    }))()`);
    check('侧栏有导入按钮', domBefore.hasImportBtn);
    check('按钮上有中文标签与提示', /导入/.test(domBefore.importLabel || '') && /JSON|Markdown/.test(domBefore.importTitle || ''),
      domBefore.importLabel + ' / ' + domBefore.importTitle);
    check('当前有 1 个对话', domBefore.convCount === 1, String(domBefore.convCount));

    // 点导出（默认 .md）
    await js(`(() => {
      const b = document.querySelector('#conv-list .conv-item button[data-act="export"]');
      b.click(); return true;
    })()`);
    await sleep(1200);
    check('导出文件写出来了', fs.existsSync(exportPath));
    check('导出内容含标记', fs.existsSync(exportPath) && fs.readFileSync(exportPath, 'utf8').includes(MARKER));

    // 删掉这个对话（模拟"换台电脑 / 数据没了"）
    const afterDelete = await js(`(async () => {
      const s = await window.api.getState();
      for (const c of s.conversations) await window.api.deleteConversation(c.id);
      const fresh = await window.api.createConversation({ title: '空对话' });
      return (await window.api.getState()).conversations.length;
    })()`);
    check('清空后只剩新建的空对话', afterDelete === 1, String(afterDelete));

    win.webContents.reload();
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await sleep(1600);

    // 点导入，选中刚才导出的 Markdown
    openQueue = [[exportPath]];
    await js(`document.querySelector('#btn-import').click(); true`);
    await sleep(2500);

    check('导入时弹出了文件选择框', openCalls.length >= 1, JSON.stringify(openCalls));
    const afterImport = await js(`(async () => {
      const s = await window.api.getState();
      const conv = s.conversations.find(c => c.title === '往返测试对话');
      return {
        total: s.conversations.length,
        found: !!conv,
        messages: conv ? conv.messages.length : 0,
        firstContent: conv && conv.messages[0] ? conv.messages[0].content : null,
        secondRole: conv && conv.messages[1] ? conv.messages[1].role : null,
        secondContent: conv && conv.messages[1] ? conv.messages[1].content : null,
        sidebarTitles: [...document.querySelectorAll('#conv-list .conv-name')].map(e => e.textContent),
      };
    })()`);
    check('导入后对话回到了列表里', afterImport.found, JSON.stringify(afterImport.sidebarTitles));
    check('消息条数正确', afterImport.messages === 2, String(afterImport.messages));
    check('用户消息内容完整', (afterImport.firstContent || '').includes(MARKER), afterImport.firstContent);
    check('AI 消息角色与内容还原（含 Markdown）',
      afterImport.secondRole === 'assistant' && /回答标题/.test(afterImport.secondContent || ''),
      afterImport.secondRole + ' / ' + afterImport.secondContent);
    check('侧栏也显示了导入的对话', afterImport.sidebarTitles.includes('往返测试对话'), JSON.stringify(afterImport.sidebarTitles));

    console.log('\nB. 导入整库备份（追加，不动现有对话）');
    // 造一个"别人电脑上的"备份文件
    const foreign = {
      type: 'better-than-chatbox-backup',
      formatVersion: 1,
      app: 'BetterThanChatbox',
      appVersion: '1.1.0',
      exportedAt: new Date().toISOString(),
      counts: { connections: 1, conversations: 2, messages: 2 },
      settings: { theme: 'dark' },
      activeConnectionId: 'other-conn',
      connections: [{ id: 'other-conn', name: '别人的接口', type: 'openai', apiKey: 'sk-someone-else', model: 'm' }],
      conversations: [
        { id: 'x1', title: '同事的对话 A', messages: [
          { id: 'x1m1', role: 'user', content: '同事的问题' },
          { id: 'x1m2', role: 'assistant', content: '同事得到的回答' },
        ] },
        { id: 'x2', title: '同事的对话 B', messages: [{ id: 'x2m1', role: 'user', content: '另一个问题' }] },
      ],
    };
    fs.writeFileSync(backupImportPath, JSON.stringify(foreign, null, 2), 'utf8');

    openQueue = [[backupImportPath]];
    await js(`document.querySelector('#btn-import').click(); true`);
    await sleep(2500);

    const afterBackup = await js(`(async () => {
      const s = await window.api.getState();
      return {
        total: s.conversations.length,
        titles: s.conversations.map(c => c.title),
        connections: s.connections.length,
        importOrder: s.conversations.slice(0, 2).map(c => c.title),
        msgsA: (s.conversations.find(c => c.title === '同事的对话 A') || {}).messages?.length,
      };
    })()`);
    check('两个对话都被追加进来（1 空 + 1 往返 + 2 同事 = 4）', afterBackup.total === 4, JSON.stringify(afterBackup.titles));
    check('现有对话没被覆盖或删除',
      afterBackup.titles.includes('往返测试对话') && afterBackup.titles.includes('空对话'),
      JSON.stringify(afterBackup.titles));
    check('导入的对话排在列表最前面', afterBackup.importOrder[0] === '同事的对话 A', JSON.stringify(afterBackup.importOrder));
    check('消息内容完整', afterBackup.msgsA === 2, String(afterBackup.msgsA));
    check('没有把别人的接口配置带进来（不覆盖本机接口）', afterBackup.connections === 0, String(afterBackup.connections));

    console.log('\nC. 坏文件 / 取消');
    fs.writeFileSync(path.join(outDir, '坏文件.json'), '{这不是 json', 'utf8');
    openQueue = [[path.join(outDir, '坏文件.json')]];
    const badResult = await js(`(async () => await window.api.importConversations())()`);
    check('坏文件被拒绝且给出可读错误',
      badResult && badResult.imported === 0 && /不是合法的 JSON/.test((badResult.errors || [])[0] || ''),
      JSON.stringify(badResult));

    openQueue = [];  // 让对话框返回"取消"
    const cancelResult = await js(`(async () => await window.api.importConversations())()`);
    check('取消对话框时什么都不做', cancelResult && cancelResult.canceled === true, JSON.stringify(cancelResult));

    const finalCount = await js(`(async () => (await window.api.getState()).conversations.length)()`);
    check('失败与取消都没有改动对话列表', finalCount === 4, String(finalCount));

    // 截图
    try {
      win.setAlwaysOnTop(true);
      win.focus();
      await sleep(800);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, 'after-import.png'), img.toPNG());
      win.setAlwaysOnTop(false);
      console.log('  （截图：' + path.join(outDir, 'after-import.png') + '）');
    } catch (err) {
      console.log('  （截图失败，不影响测试：' + err.message + '）');
    }
  } catch (err) {
    check('驱动自身没有抛异常', false, err.message + '\n' + (err.stack || ''));
  }

  const failed = checks.filter((c) => !c.pass);
  fs.writeFileSync(path.join(outDir, 'e2e-report.json'), JSON.stringify({
    suite: 'import-e2e', total: checks.length, failed: failed.length, checks,
  }, null, 2), 'utf8');
  console.log('\n导入对话端到端：共 ' + checks.length + ' 项，失败 ' + failed.length + ' 项');
  if (failed.length) throw new Error(failed.length + ' 项检查未通过：' + failed.map((f) => f.name).join('、'));
};
