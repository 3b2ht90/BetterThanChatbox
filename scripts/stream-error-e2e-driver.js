'use strict';

// 「回答到一半连接被掐断」的端到端测试驱动。由主进程 require 后调用，参数是 (win, app)。
//
// 用户看到的是「⚠️ terminated」——那是 undici 的原始英文报错直接透传上来了。
// 这里用假接口**在流式过程中销毁连接**复现，然后检查：
//   1. 界面上给的是能看懂的中文说明（不是 terminated / other side closed）
//   2. 已经收到的那部分回答没有被丢掉
//   3. 点「重新回答」能正常拿到完整回答（不给用户留下死局）
//
// 用法见 scripts/run-stream-error-e2e.mjs

const http = require('http');
const path = require('path');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PART_1 = '先给你一部分：\n\n';
const PART_2 = '- 第一点\n';
const FULL = '# 完整回答\n\n这次连接没断，内容是完整的。\n';

module.exports = async function streamErrorE2E(win, app) {
  const checks = [];
  const check = (name, pass, extra) => {
    checks.push({ name, pass: !!pass, extra: extra === undefined ? null : String(extra) });
    console.log((pass ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined && !pass ? '  → ' + extra : ''));
  };
  const js = (code) => win.webContents.executeJavaScript(code, true);

  let chatCalls = 0;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }] }));
      return;
    }
    if (req.url.startsWith('/v1/chat/completions')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        chatCalls++;
        if (chatCalls === 1) {
          // 第一次：吐两段内容，然后**把连接掐掉**（复现 terminated）
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: PART_1 } }] }) + '\n\n');
          setTimeout(() => {
            try {
              res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: PART_2 } }] }) + '\n\n');
            } catch (e) { /* ignore */ }
            setTimeout(() => { try { res.destroy(); } catch (e) { /* ignore */ } }, 120);
          }, 150);
          return;
        }
        // 之后：正常完整回答
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const chunk of (FULL.match(/[\s\S]{1,16}/g) || [])) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: chunk } }] }) + '\n\n');
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
  console.log('假接口：' + baseUrl + '（第 1 次对话会在中途掐断连接）');

  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  await sleep(1500);

  try {
    await js(`(async () => {
      const s = await window.api.getState();
      for (const c of s.connections) await window.api.deleteConnection(c.id);
      const conn = await window.api.addConnection({
        name: '掐线接口', type: 'openai', baseUrl: ${JSON.stringify(baseUrl)},
        apiKey: 'sk-fake', model: 'mock-model'
      });
      await window.api.setActiveConnection(conn.id);
      for (const c of s.conversations) await window.api.deleteConversation(c.id);
      await window.api.createConversation({ connectionId: conn.id, title: '断线测试' });
      return true;
    })()`);
    win.webContents.reload();
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await sleep(1600);

    console.log('\n发一条消息，让接口在回答中途掐断');
    await js(`(() => {
      const i = document.querySelector('#input');
      i.value = '讲一下这个方案';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#btn-send').click();
      return true;
    })()`);

    // 等错误出现
    let waited = 0;
    let dom = null;
    while (waited < 30000) {
      await sleep(400);
      waited += 400;
      dom = await js(`(() => {
        const err = document.querySelector('#messages .msg-error');
        const ai = [...document.querySelectorAll('#messages .msg-assistant')].pop();
        const bubble = ai ? ai.querySelector('.bubble') : null;
        const errBox = err ? err.querySelector('.bubble:last-child') : null;
        return {
          hasError: !!err,
          errorText: errBox ? errBox.textContent : (err ? err.textContent : ''),
          bubbleText: bubble ? bubble.textContent : '',
          hasRetry: ai ? !!ai.querySelector('button[data-act="retry"]') : false,
        };
      })()`);
      if (dom && dom.hasError) break;
    }

    check('界面进入了失败状态', dom && dom.hasError, JSON.stringify(dom));
    check('错误说明是中文、能看懂，而且提到「中断」',
      !!dom && /中断/.test(dom.errorText) && /[\u4e00-\u9fa5]/.test(dom.errorText),
      dom && dom.errorText);
    check('不再把原始英文报错透传给用户（terminated / other side closed）',
      !!dom && !/terminated|other side closed|UND_ERR_SOCKET/i.test(dom.errorText),
      dom && dom.errorText);
    check('提示了怎么处理（重新回答再试）',
      !!dom && /重新回答/.test(dom.errorText), dom && dom.errorText);
    check('已经收到的部分回答被保留下来，没有一起丢掉',
      !!dom && dom.bubbleText.includes('先给你一部分') && dom.bubbleText.includes('第一点'),
      dom && dom.bubbleText);
    check('失败的消息上仍然有「重新回答」可用', !!dom && dom.hasRetry);

    console.log('\n点「重新回答」，这次接口正常返回');
    await js(`(() => {
      const ai = [...document.querySelectorAll('#messages .msg-assistant')].pop();
      const b = ai.querySelector('button[data-act="retry"]');
      b.click();
      return true;
    })()`);

    waited = 0;
    let after = null;
    while (waited < 30000) {
      await sleep(400);
      waited += 400;
      after = await js(`(() => {
        const ai = [...document.querySelectorAll('#messages .msg-assistant')].pop();
        const bubble = ai ? ai.querySelector('.bubble') : null;
        const stopBusy = document.querySelector('#btn-send').textContent.includes('停止');
        return {
          busy: stopBusy,
          text: bubble ? bubble.textContent : '',
          variants: ai ? (ai.querySelector('.variant-pos') ? ai.querySelector('.variant-pos').textContent : '') : '',
          stillError: ai ? ai.classList.contains('msg-error') : false,
        };
      })()`);
      if (after && !after.busy && after.text.includes('完整回答')) break;
    }
    check('重试后拿到了完整的回答', !!after && after.text.includes('这次连接没断'), after && after.text);
    check('重试产生的版本被记为第 2 版（旧的那次没丢）',
      !!after && /2\s*\/\s*2/.test(after.variants), after && after.variants);

    console.log('\n附带确认：历史记录里保留了失败原因');
    // 注意：重试成功后，消息顶层的 content/error 反映的是**当前选中的那一版**，
    // 失败那次的错误文本在 versions 里，所以两边都要看。
    const stored = await js(`(async () => {
      const s = await window.api.getState();
      const conv = s.conversations.find(c => c.title === '断线测试');
      const msgs = conv ? conv.messages.filter(m => m.role === 'assistant') : [];
      return msgs.map(m => ({
        error: m.error || null,
        variants: (m.variants || []).map(v => ({ error: v.error || null, content: (v.content || '').slice(0, 16) })),
      }));
    })()`);
    const allErrors = [];
    for (const m of stored || []) {
      if (m.error) allErrors.push(m.error);
      for (const v of m.variants || []) if (v.error) allErrors.push(v.error);
    }
    check('落盘的记录里错误原因是中文说明',
      allErrors.some((e) => /中断/.test(e)), JSON.stringify(allErrors));
    check('落盘的记录里没有原始英文报错',
      !allErrors.some((e) => /terminated|other side closed/i.test(e)), JSON.stringify(allErrors));
    check('失败的那一版也留在历史里（没有被重试覆盖掉）',
      (stored || []).some((m) => (m.variants || []).some((v) => v.error && /中断/.test(v.error))),
      JSON.stringify(stored));

    try {
      const outDir = path.join(app.getPath('userData'), 'stream-error-e2e-out');
      fs.mkdirSync(outDir, { recursive: true });
      win.setAlwaysOnTop(true); win.focus(); await sleep(700);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, 'stream-error.png'), img.toPNG());
      win.setAlwaysOnTop(false);
      console.log('  （截图：' + path.join(outDir, 'stream-error.png') + '）');
    } catch (err) {
      console.log('  （截图失败，不影响测试：' + err.message + '）');
    }
  } catch (err) {
    check('驱动自身没有抛异常', false, err.message + '\n' + (err.stack || ''));
  } finally {
    server.close();
  }

  const failed = checks.filter((c) => !c.pass);
  const outDir = path.join(app.getPath('userData'), 'stream-error-e2e-out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'e2e-report.json'), JSON.stringify({
    suite: 'stream-error-e2e', total: checks.length, failed: failed.length, checks,
  }, null, 2), 'utf8');
  console.log('\n断线报错端到端：共 ' + checks.length + ' 项，失败 ' + failed.length + ' 项');
  if (failed.length) throw new Error(failed.length + ' 项检查未通过：' + failed.map((f) => f.name).join('、'));
};
