'use strict';

// 诊断驱动：把关键 DOM / 渲染结果 dump 出来
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startMock(state) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        state.requests.push({ url: req.url, body: parsed });
        if (/\/models/.test(req.url)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'mock-model-a' }] }));
          return;
        }
        const chunks = ['收到，这是**流式**回复。\n\n', '```js\nconsole.log("hello");\n```\n\n', '| a | b |\n| --- | --- |\n| 1 | 2 |\n'];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let i = 0;
        const timer = setInterval(() => {
          if (i >= chunks.length) { clearInterval(timer); res.write('data: [DONE]\n\n'); res.end(); return; }
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: chunks[i] } }] }) + '\n\n');
          i++;
        }, 150);
        res.on('close', () => clearInterval(timer));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

module.exports = async function debug(win, app) {
  const out = {};
  const state = { requests: [] };
  const server = await startMock(state);
  const port = server.address().port;

  const js = async (code) => {
    try { return await win.webContents.executeJavaScript(code, true); }
    catch (e) { return { __error: String((e && e.message) || e) }; }
  };

  for (let i = 0; i < 150 && win.webContents.isLoading(); i++) await sleep(100);
  await sleep(1200);

  // 直接用主进程渲染一次 Markdown，检查渲染管线
  out.renderMarkdownDirect = await js("window.api.renderMarkdown('```js\\nconst a = 1;\\n```\\n\\n| a | b |\\n| --- | --- |\\n| 1 | 2 |')");

  // 配接口
  await js("[...document.querySelectorAll('.modal-body button')].find(b => b.textContent.includes('添加接口')).click()");
  await sleep(300);
  await js(`(() => {
    const ins = document.querySelector('.conn-card').querySelectorAll('input');
    const set = (e, v) => { e.value = v; e.dispatchEvent(new Event('input', {bubbles:true})); };
    set(ins[0], '模拟接口'); set(ins[1], 'http://127.0.0.1:${port}/v1'); set(ins[2], 'k'); set(ins[3], 'mock-model');
    return true;
  })()`);
  await js("[...document.querySelectorAll('.conn-card button')].find(b => b.textContent.includes('保存')).click()");
  await sleep(200);
  await js("document.querySelector('.modal-head [data-close]').click()");
  await sleep(300);

  // 发消息
  await js("window.__dbg = []");
  await js(`(() => { const t = document.querySelector('#input'); t.value = '测试'; t.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
  await js("document.querySelector('#btn-send').click()");
  await sleep(500);
  out.midStream = await js("({ chatReqs: 1, bubbleLen: (document.querySelector('.msg-assistant .bubble')||{}).innerHTML ? document.querySelector('.msg-assistant .bubble').innerHTML.length : -1 })");

  for (let i = 0; i < 60; i++) {
    const busy = await js("document.querySelector('#btn-send').textContent.includes('停止')");
    if (busy !== true) break;
    await sleep(200);
  }
  await sleep(500);

  out.afterReply = await js(`(() => {
    const b = document.querySelector('.msg-assistant .bubble');
    return {
      bubbleHtml: b ? b.innerHTML.slice(0, 400) : null,
      bubbleText: b ? b.textContent.slice(0, 200) : null,
      codeBlocks: document.querySelectorAll('.code-block').length,
      tables: document.querySelectorAll('table').length,
      pres: document.querySelectorAll('.msg-assistant pre').length,
      errBoxes: document.querySelectorAll('.msg-error').length,
    };
  })()`);

  out.eventLog = await js('(window.__dbg || []).slice(0, 60)');

  // 拖文件
  const pngBase64 = (() => {
    const w = 8, h = 8;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = 200; raw[o + 1] = 40; raw[o + 2] = 40; raw[o + 3] = 255; } }
    let table = null;
    const crc32 = (buf) => {
      if (!table) { table = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; } }
      let c = -1; for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0;
    };
    const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length, 0); const t = Buffer.from(type, 'ascii'); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([t, data])), 0); return Buffer.concat([l, t, data, cr]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
  })();

  out.afterDrop = await js(`
    (async () => {
      const bin = atob(${JSON.stringify(pngBase64)});
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const f1 = new File([arr], 'x.png', { type: 'image/png' });
      const f2 = new File(['文件正文内容ABC'], 'n.txt', { type: 'text/plain' });
      const dt = new DataTransfer(); dt.items.add(f1); dt.items.add(f2);
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 900));
      return {
        pendingChildren: document.querySelector('#pending').children.length,
        pendingHtml: document.querySelector('#pending').innerHTML.slice(0, 260),
        pendingHidden: document.querySelector('#pending').classList.contains('hidden'),
      };
    })()`);

  const reqsBefore = state.requests.filter((r) => /chat\/completions/.test(r.url)).length;
  await js("document.querySelector('#btn-send').click()");
  await sleep(1200);

  out.secondSend = await js(`({
    sendLabel: document.querySelector('#btn-send').textContent,
    userMsgs: document.querySelectorAll('.msg-user').length,
    pendingChildren: document.querySelector('#pending').children.length,
    inputValue: document.querySelector('#input').value,
    toast: document.querySelector('#toast').textContent,
  })`);

  for (let i = 0; i < 40; i++) {
    const busy = await js("document.querySelector('#btn-send').textContent.includes('停止')");
    if (busy !== true) break;
    await sleep(200);
  }

  const reqs = state.requests.filter((r) => /chat\/completions/.test(r.url));
  out.requestStats = {
    before: reqsBefore,
    total: reqs.length,
    lastUserContent: (() => {
      const last = reqs[reqs.length - 1];
      if (!last) return null;
      const u = (last.body.messages || []).filter((m) => m.role === 'user').pop();
      return u ? (typeof u.content === 'string' ? u.content.slice(0, 120) : u.content) : null;
    })(),
  };

  fs.writeFileSync(path.join(__dirname, '..', 'debug-dump.json'), JSON.stringify(out, null, 2), 'utf8');
  server.close();
  app.quit();
};
