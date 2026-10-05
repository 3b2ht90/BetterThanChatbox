'use strict';

// 「上下文用量显示 + 压缩上下文」的端到端测试驱动。
// 由主进程 require 后调用，参数是 (win, app)。
//
// 覆盖用户实际会做的事：
//   1. 用量条显示「约 N / M tokens（x%）」
//   2. 点「压缩上下文」→ 较早的对话被总结成一条摘要消息，原文折叠但仍可展开
//   3. 压缩后真实请求体里**不再有**那些旧消息，但**有**摘要
//   4. 点「取消压缩」→ 原文重新参与上下文
//
// 用法见 scripts/run-context-e2e.mjs

const http = require('http');
const path = require('path');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SUMMARY = '【要点】\n- 用户在测试上下文压缩功能\n- 接口地址与模型已配置好\n- 待办：确认压缩后旧消息不再占用上下文';
// 三种标记要能区分开：被压缩掉的 / 被保留的（最近的）/ 压缩之后新说的
const MARK_OLD = '要被压缩掉的老消息';
const MARK_KEPT = '被保留下来的较近消息';
const MARK_NEW = '压缩之后 새로 说的消息';

module.exports = async function contextE2E(win, app) {
  const checks = [];
  const check = (name, pass, extra) => {
    checks.push({ name, pass: !!pass, extra: extra === undefined ? null : String(extra) });
    console.log((pass ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined && !pass ? '  → ' + extra : ''));
  };
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const chatBodies = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'ctx-model' }] }));
      return;
    }
    if (req.url.startsWith('/v1/chat/completions')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        const isCompact = (parsed.messages || []).some((m) =>
          m.role === 'system' && /压缩器/.test(String(m.content || '')));
        chatBodies.push({ isCompact, body: parsed });
        const text = isCompact ? SUMMARY : '收到，这是普通回答。';
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const piece of (text.match(/[\s\S]{1,20}/g) || [])) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  console.log('假接口：' + baseUrl);

  const { dialog } = require('electron');
  dialog.showSaveDialog = async () => ({ canceled: true });
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  dialog.showMessageBox = async () => ({ response: 1 });

  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  await sleep(1500);

  try {
    // ---------- 准备：一个接口 + 一个装了 12 条消息的对话 ----------
    await js(`(async () => {
      const s = await window.api.getState();
      for (const c of s.connections) await window.api.deleteConnection(c.id);
      const conn = await window.api.addConnection({
        name: '上下文测试接口', type: 'openai', baseUrl: ${JSON.stringify(baseUrl)},
        apiKey: 'sk-fake', model: 'ctx-model'
      });
      await window.api.setActiveConnection(conn.id);
      for (const c of s.conversations) await window.api.deleteConversation(c.id);
      const conv = await window.api.createConversation({ connectionId: conn.id, title: '上下文测试' });
      // 造 12 条：前 6 条（3 轮）会被压缩掉 —— 默认保留最近 6 条；
      // 后 6 条用不同标记，用来验证"保留下来的照样在上下文里"。
      for (let i = 1; i <= 3; i++) {
        await window.api.appendMessage(conv.id, { role: 'user', content: ${JSON.stringify(MARK_OLD)} + ' 第' + i + '轮问题：' + '占位内容'.repeat(20), attachments: [] });
        await window.api.appendMessage(conv.id, { role: 'assistant', content: ${JSON.stringify(MARK_OLD)} + ' 第' + i + '轮回答：' + '占位内容'.repeat(20), attachments: [] });
      }
      for (let i = 4; i <= 6; i++) {
        await window.api.appendMessage(conv.id, { role: 'user', content: ${JSON.stringify(MARK_KEPT)} + ' 第' + i + '轮问题', attachments: [] });
        await window.api.appendMessage(conv.id, { role: 'assistant', content: ${JSON.stringify(MARK_KEPT)} + ' 第' + i + '轮回答', attachments: [] });
      }
      return (await window.api.getState()).conversations.find(c => c.id === conv.id).messages.length;
    })()`);
    win.webContents.reload();
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await sleep(1800);

    console.log('\n一、用量条');
    let bar = null;
    for (let i = 0; i < 40; i++) {
      bar = await js(`(() => {
        const b = document.querySelector('#ctx-bar');
        if (!b || b.classList.contains('hidden')) return null;
        return {
          text: b.querySelector('.ctx-text') ? b.querySelector('.ctx-text').textContent : b.textContent,
          fill: b.querySelector('.ctx-fill') ? b.querySelector('.ctx-fill').style.width : null,
          level: b.className,
          hasCompact: !!b.querySelector('[data-ctx="compact"]'),
          compactDisabled: b.querySelector('[data-ctx="compact"]') ? b.querySelector('[data-ctx="compact"]').disabled : null,
        };
      })()`);
      if (bar) break;
      await sleep(300);
    }
    check('界面出现了上下文用量条', !!bar, JSON.stringify(bar));
    check('显示「约 N / M」的 token 数', !!bar && /约\s*[\d.]+k?\s*\/\s*[\d.]+k?/.test(bar.text), bar && bar.text);
    check('显示占用百分比', !!bar && /%/.test(bar.text), bar && bar.text);
    check('有进度条', !!bar && /%$/.test(bar.fill || ''), bar && bar.fill);
    check('有「压缩上下文」按钮且可用', !!bar && bar.hasCompact && bar.compactDisabled === false, JSON.stringify(bar));

    const tokensBefore = await js(`(async () => {
      const s = await window.api.getState();
      const conv = s.conversations.find(c => c.title === '上下文测试');
      return (await window.api.contextInfo(conv.id)).tokens;
    })()`);
    check('压缩前能读到用量数字', typeof tokensBefore === 'number' && tokensBefore > 0, String(tokensBefore));

    console.log('\n二、压缩');
    await js(`document.querySelector('#ctx-bar [data-ctx="compact"]').click(); true`);
    let after = null;
    for (let i = 0; i < 60; i++) {
      await sleep(400);
      after = await js(`(() => ({
        summary: document.querySelectorAll('#messages .msg-summary').length,
        group: document.querySelectorAll('#messages .msg-compressed-group').length,
        groupText: document.querySelector('#messages .msg-compressed-group') ? document.querySelector('#messages .msg-compressed-group').textContent : '',
        summaryText: document.querySelector('#messages .msg-summary .bubble') ? document.querySelector('#messages .msg-summary .bubble').textContent : '',
        visibleOld: document.querySelectorAll('#messages .msg').length,
      }))()`);
      if (after && after.summary > 0) break;
    }
    const compactReq = chatBodies.filter((c) => c.isCompact);
    check('确实向接口发了一次「总结这段对话」的请求', compactReq.length === 1, String(compactReq.length));
    check('总结请求里带上了要被压缩的原文',
      compactReq[0] && JSON.stringify(compactReq[0].body).includes(MARK_OLD), '没带上原文');

    // 诊断：压缩标记有没有真的落到数据里（界面渲染和发请求都靠它）
    const flags = await js(`(async () => {
      const s = await window.api.getState();
      const conv = s.conversations.find(c => c.title === '上下文测试');
      return conv.messages.map(m => ({ c: !!m.compressed, s: !!m.isSummary }));
    })()`);
    const nCompressed = (flags || []).filter((f) => f.c).length;
    const nSummary = (flags || []).filter((f) => f.s).length;
    console.log('  [诊断] 共 ' + (flags || []).length + ' 条消息：压缩标记 ' + nCompressed + ' 条、摘要标记 ' + nSummary + ' 条');
    check('数据里确实有一批消息被标成已压缩', nCompressed >= 2, JSON.stringify(flags));
    check('数据里有一条摘要消息', nSummary === 1, JSON.stringify(flags));
    check('生成了一条「上下文摘要」消息', after && after.summary === 1, JSON.stringify(after));
    check('摘要内容就是接口返回的要点', after && after.summaryText.includes('要点'), after && after.summaryText);
    check('被压缩的消息折叠成一组（不再逐条显示）', after && after.group === 1, JSON.stringify(after));
    check('折叠条上写明了压缩了多少条', after && /已压缩 \d+ 条/.test(after.groupText), after && after.groupText);
    check('界面上可见的消息数明显变少（老消息被折叠）',
      after && after.visibleOld <= 8, after && String(after.visibleOld));

    const tokensAfter = await js(`(async () => {
      const s = await window.api.getState();
      const conv = s.conversations.find(c => c.title === '上下文测试');
      const info = await window.api.contextInfo(conv.id);
      return { tokens: info.tokens, compressed: info.compressed, canCompress: info.canCompress };
    })()`);
    check('压缩后上下文占用变小了', tokensAfter.tokens < tokensBefore, `${tokensBefore} → ${tokensAfter.tokens}`);
    check('用量信息里记下了"已压缩 N 条"', tokensAfter.compressed > 0, JSON.stringify(tokensAfter));

    console.log('\n三、压缩后的真实请求体');
    await js(`(() => { const t = document.querySelector('#input'); t.value = '压缩之后问一句'; t.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
    await js("document.querySelector('#btn-send').click()");
    for (let i = 0; i < 60; i++) {
      const busy = await js("document.querySelector('#btn-send').textContent.includes('停止')");
      if (!busy) break;
      await sleep(300);
    }
    await sleep(500);
    const chatReq = chatBodies.filter((c) => !c.isCompact).pop();
    const reqText = JSON.stringify(chatReq ? chatReq.body : {});
    check('压缩后的普通请求里**不再有**被压缩掉的老消息', !reqText.includes(MARK_OLD), reqText.slice(0, 200));
    check('但仍然带着那条摘要', reqText.includes('要点'), reqText.slice(0, 200));
    check('保留下来的较近消息照常在上下文里', reqText.includes(MARK_KEPT), reqText.slice(0, 200));
    check('刚发的新消息也在', reqText.includes('压缩之后'), reqText.slice(0, 200));

    console.log('\n四、展开原文 / 取消压缩');
    const expanded = await js(`(async () => {
      const g = document.querySelector('#messages .msg-compressed-group');
      g.click();
      await new Promise(r => setTimeout(r, 300));
      return {
        group: document.querySelectorAll('#messages .msg-compressed-group').length,
        hasOld: document.body.textContent.includes(${JSON.stringify(MARK_OLD)}),
        msgCount: document.querySelectorAll('#messages .msg').length,
      };
    })()`);
    check('点折叠条能展开原文（内容一点没丢）', expanded.hasOld, JSON.stringify(expanded));
    check('展开后消息条数变多', expanded.msgCount > 6, String(expanded.msgCount));

    await js(`document.querySelector('#ctx-bar [data-ctx="uncompact"]').click(); true`);
    await sleep(900);
    const undone = await js(`(async () => {
      const s = await window.api.getState();
      const conv = s.conversations.find(c => c.title === '上下文测试');
      const info = await window.api.contextInfo(conv.id);
      return {
        compressed: info.compressed,
        tokens: info.tokens,
        groups: document.querySelectorAll('#messages .msg-compressed-group').length,
      };
    })()`);
    check('取消压缩后没有已压缩的消息了', undone.compressed === 0, JSON.stringify(undone));
    check('折叠条消失', undone.groups === 0, String(undone.groups));
    check('原文重新计入上下文（用量回升）', undone.tokens > tokensAfter.tokens, `${tokensAfter.tokens} → ${undone.tokens}`);

    try {
      const outDir = path.join(app.getPath('userData'), 'context-e2e-out');
      fs.mkdirSync(outDir, { recursive: true });
      win.setAlwaysOnTop(true); win.focus(); await sleep(800);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, 'context-bar.png'), img.toPNG());
      win.setAlwaysOnTop(false);
      console.log('  （截图：' + path.join(outDir, 'context-bar.png') + '）');
    } catch (err) {
      console.log('  （截图失败，不影响测试：' + err.message + '）');
    }
  } catch (err) {
    check('驱动自身没有抛异常', false, err.message + '\n' + (err.stack || ''));
  } finally {
    server.close();
  }

  const failed = checks.filter((c) => !c.pass);
  const outDir = path.join(app.getPath('userData'), 'context-e2e-out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'e2e-report.json'), JSON.stringify({
    suite: 'context-e2e', total: checks.length, failed: failed.length, checks,
  }, null, 2), 'utf8');
  console.log('\n上下文端到端：共 ' + checks.length + ' 项，失败 ' + failed.length + ' 项');
  if (failed.length) throw new Error(failed.length + ' 项检查未通过：' + failed.map((f) => f.name).join('、'));
};
