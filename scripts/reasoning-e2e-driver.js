'use strict';

// 「完整显示思考过程」的端到端测试驱动。由主进程 require 后调用，参数是 (win, app)。
//
// 假接口吐一段**很长的**思考 + 一段正文，然后验证：
//   界面上拿到的思考文本与接口发出的**逐字符一致**（不是被截断的一段）
//   字数统计正确、可折叠/展开、刷新页面后还在、导出的 Markdown 里也带完整思考
//
// 用法见 scripts/run-reasoning-e2e.mjs

const http = require('http');
const path = require('path');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 造一段足够长的思考：600 段，每段带序号，方便定位有没有丢片段
const PIECES = [];
for (let i = 0; i < 600; i++) PIECES.push(`第${i}步：检查条件${i}是否成立，结论是${i % 3 === 0 ? '成立' : '不成立'}。\n`);
PIECES.push('（思考结束）');
const FULL_REASONING = PIECES.join('');
const ANSWER = '# 结论\n\n根据以上推理，答案是 42。\n';

module.exports = async function reasoningE2E(win, app) {
  const checks = [];
  const check = (name, pass, extra) => {
    checks.push({ name, pass: !!pass, extra: extra === undefined ? null : String(extra) });
    console.log((pass ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined && !pass ? '  → ' + extra : ''));
  };
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'reasoner-test' }] }));
      return;
    }
    if (req.url.startsWith('/v1/chat/completions')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // 思考按小块吐（模拟真实流式），正文最后吐
        for (const p of PIECES) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: p } }] }) + '\n\n');
        }
        for (const chunk of ANSWER.match(/[\s\S]{1,12}/g) || []) {
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
  console.log('假接口：' + baseUrl);
  console.log('思考长度：' + FULL_REASONING.length + ' 字符 / ' + PIECES.length + ' 个片段');

  // 导出用假保存框
  const { dialog } = require('electron');
  const outDir = path.join(app.getPath('userData'), 'reasoning-e2e-out');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const exportPath = path.join(outDir, '带思考的对话.md');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath });

  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  await sleep(1500);

  try {
    await js(`(async () => {
      const s = await window.api.getState();
      for (const c of s.connections) await window.api.deleteConnection(c.id);
      const conn = await window.api.addConnection({
        name: '推理接口', type: 'openai', baseUrl: ${JSON.stringify(baseUrl)},
        apiKey: 'sk-fake', model: 'reasoner-test'
      });
      await window.api.setActiveConnection(conn.id);
      for (const c of s.conversations) await window.api.deleteConversation(c.id);
      const conv = await window.api.createConversation({ connectionId: conn.id, title: '思考过程测试' });
      return conv.id;
    })()`);
    win.webContents.reload();
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await sleep(1600);

    console.log('\n发一条消息，等它把思考吐完');
    await js(`(() => {
      const i = document.querySelector('#input');
      i.value = '给我一个需要仔细推理的问题';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#btn-send').click();
      return true;
    })()`);

    // 等流式结束（思考块不再处于 streaming 状态）
    let waited = 0;
    let streaming = true;
    while (waited < 60000) {
      await sleep(500);
      waited += 500;
      streaming = await js(`(() => {
        const r = document.querySelector('#messages .reasoning');
        return !!(r && r.classList.contains('streaming'));
      })()`);
      if (!streaming) break;
    }
    check('思考流式结束（没有卡住）', !streaming, '等了 ' + waited + 'ms');

    const dom = await js(`(() => {
      const box = document.querySelector('#messages .reasoning');
      if (!box) return { found: false };
      const body = box.querySelector('.r-body');
      const text = body ? body.textContent : '';
      return {
        found: true,
        len: text.length,
        head: text.slice(0, 40),
        tail: text.slice(-20),
        meta: box.querySelector('.r-meta').textContent,
        collapsed: box.classList.contains('collapsed'),
        streaming: box.classList.contains('streaming'),
        title: box.querySelector('.r-title').textContent,
        hasToggle: !!box.querySelector('.r-toggle'),
        hasCopy: !!box.querySelector('.r-copy'),
        scrollable: body ? body.scrollHeight > body.clientHeight : null,
        // 注意要取「AI 那条消息」的气泡：直接 querySelector('.bubble') 拿到的是用户消息
        bubbleText: (() => {
          const aiMsgs = [...document.querySelectorAll('#messages .msg-assistant')];
          const last = aiMsgs[aiMsgs.length - 1];
          return last ? (last.querySelector('.bubble') || {}).textContent || '' : '';
        })(),
      };
    })()`);

    check('界面上出现了思考过程块', dom.found);
    check('思考文本长度与接口发出的完全一致', dom.len === FULL_REASONING.length,
      `${dom.len} vs ${FULL_REASONING.length}`);
    check('开头正确', dom.head === FULL_REASONING.slice(0, 40), dom.head);
    check('结尾正确（最后几个片段没丢）', dom.tail === FULL_REASONING.slice(-20), JSON.stringify(dom.tail));
    check('字数统计正确', dom.meta === FULL_REASONING.length.toLocaleString() + ' 字', dom.meta);
    check('默认是展开状态（能直接看到）', dom.collapsed === false);
    check('有折叠按钮与复制按钮', dom.hasToggle && dom.hasCopy);
    check('思考没有混进正式回答', !dom.bubbleText.includes('第0步：') && dom.bubbleText.includes('答案是 42'),
      dom.bubbleText.slice(0, 60));
    check('长思考内部可滚动（内容都在，只是限高）', dom.scrollable === true);

    console.log('\n折叠 / 展开 / 铺开');
    const folded = await js(`(() => {
      const box = document.querySelector('#messages .reasoning');
      box.querySelector('.r-head').click();
      const body = box.querySelector('.r-body');
      return { collapsed: box.classList.contains('collapsed'),
               visible: body ? getComputedStyle(body).display !== 'none' : null,
               label: box.querySelector('.r-toggle').textContent };
    })()`);
    check('点标题栏可以折叠起来', folded.collapsed === true && folded.visible === false);
    check('折叠后按钮变成「展开」', folded.label === '展开', folded.label);

    const unfolded = await js(`(() => {
      const box = document.querySelector('#messages .reasoning');
      box.querySelector('.r-toggle').click();
      const body = box.querySelector('.r-body');
      return { collapsed: box.classList.contains('collapsed'),
               len: body.textContent.length };
    })()`);
    check('再点可以展开回来，内容一点没少', unfolded.collapsed === false && unfolded.len === FULL_REASONING.length);

    console.log('\n刷新页面后还在吗');
    win.webContents.reload();
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await sleep(1800);
    const after = await js(`(() => {
      const box = document.querySelector('#messages .reasoning');
      return { found: !!box, len: box ? box.querySelector('.r-body').textContent.length : 0 };
    })()`);
    check('刷新后思考过程仍在界面上', after.found && after.len === FULL_REASONING.length,
      `${after.len} vs ${FULL_REASONING.length}`);

    console.log('\n导出时也带上完整思考');
    await js(`(() => {
      const b = document.querySelector('#conv-list .conv-item button[data-act="export"]');
      b.click(); return true;
    })()`);
    await sleep(1200);
    const md = fs.existsSync(exportPath) ? fs.readFileSync(exportPath, 'utf8') : '';
    const inDetails = /<details><summary>思考过程<\/summary>\n([\s\S]*?)\n<\/details>/.exec(md);
    check('导出的 Markdown 里有思考折叠块', !!inDetails);
    check('导出里的思考也是完整的', !!inDetails && inDetails[1].trim().length === FULL_REASONING.trim().length,
      inDetails ? `${inDetails[1].trim().length} vs ${FULL_REASONING.trim().length}` : 'n/a');

    try {
      win.setAlwaysOnTop(true); win.focus(); await sleep(800);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, 'reasoning.png'), img.toPNG());
      win.setAlwaysOnTop(false);
      console.log('  （截图：' + path.join(outDir, 'reasoning.png') + '）');
    } catch (err) {
      console.log('  （截图失败，不影响测试：' + err.message + '）');
    }
  } catch (err) {
    check('驱动自身没有抛异常', false, err.message + '\n' + (err.stack || ''));
  } finally {
    server.close();
  }

  const failed = checks.filter((c) => !c.pass);
  fs.writeFileSync(path.join(outDir, 'e2e-report.json'), JSON.stringify({
    suite: 'reasoning-e2e', total: checks.length, failed: failed.length, checks,
  }, null, 2), 'utf8');
  console.log('\n思考过程端到端：共 ' + checks.length + ' 项，失败 ' + failed.length + ' 项');
  if (failed.length) throw new Error(failed.length + ' 项检查未通过：' + failed.map((f) => f.name).join('、'));
};
