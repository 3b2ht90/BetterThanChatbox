'use strict';

// 自动化冒烟测试驱动：由 app/main.js 在 BTC_SMOKE_SCRIPT 指向本文件时调用。
// 流程：起一个假的 OpenAI 兼容接口 → 在真实界面上配置接口 → 发消息（验证流式+Markdown）
// → 拖入图片/文本文件（验证视觉消息构造）→ 重命名/删除对话 → 截图 + 输出报告。
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 一个最小 PNG 生成器（避免依赖外部素材） ----------
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function makePng(w, h, [r, g, b, a]) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 假接口 ----------
function startMockServer(state) {
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
          res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model-a' }, { id: 'mock-model-b' }] }));
          return;
        }

        // 每次回答带上序号，方便验证「重新回答 / 分支」拿到的是不同的新回答
        state.answerNo = (state.answerNo || 0) + 1;
        const chunks = [
          '第 ' + state.answerNo + ' 次回答：收到，这是**流式**回复。\n\n',
          '1. 第一点\n2. 第二点\n\n',
          '```js\nconsole.log("hello 高亮");\n```\n\n',
          '| 名称 | 值 |\n| --- | --- |\n| a | 1 |\n\n',
          '> 引用测试\n\n结束。',
        ];
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        let i = 0;
        const timer = setInterval(() => {
          if (i >= chunks.length) {
            clearInterval(timer);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: chunks[i] } }] }) + '\n\n');
          i++;
        }, 200);
        // 注意：不能用 req.on('close')——Node 16+ 在请求体读完后就会触发，会把定时器清掉
        res.on('close', () => clearInterval(timer));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

module.exports = async function smoke(win, app) {
  const outDir = path.join(__dirname, '..', 'test-artifacts');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const state = { requests: [] };
  const server = await startMockServer(state);
  const port = server.address().port;
  const report = { port, checks: [], errors: [] };

  const js = async (code) => {
    try {
      return await win.webContents.executeJavaScript(code, true);
    } catch (err) {
      const msg = String((err && err.message) || err);
      report.errors.push(msg);
      console.error('[js] ' + msg); // 打到 stderr，冒烟崩了也能看到原因
      return null;
    }
  };
  const shot = async (name) => {
    // 截图只是留证，失败（比如窗口刚好被别的窗口遮住）不应该让整轮测试挂掉
    try {
      const img = await win.capturePage();
      fs.writeFileSync(path.join(outDir, name + '.png'), img.toPNG());
    } catch (err) {
      report.warnings = report.warnings || [];
      report.warnings.push(name + ': ' + String((err && err.message) || err));
    }
  };
  const check = (name, value) => report.checks.push({ name, value });

  // 等待界面加载完成
  for (let i = 0; i < 150 && win.webContents.isLoading(); i++) await sleep(100);
  await sleep(1400);

  // --- 1. 初始界面 ---
  check('init.hasApi', await js('!!window.api'));
  check('init.conversations', await js("document.querySelectorAll('.conv-item').length"));
  check('init.settingsAutoOpen', await js("!!document.querySelector('.modal-mask')"));
  check('layout.sidebarWidth', await js("document.querySelector('#sidebar').getBoundingClientRect().width"));
  check('layout.mainWidth', await js("Math.round(document.querySelector('#main').getBoundingClientRect().width)"));
  check('layout.composerVisible', await js("document.querySelector('#composer').getBoundingClientRect().height > 30"));
  check('layout.bodyNoScroll', await js("document.body.scrollHeight <= window.innerHeight + 2"));
  await shot('01-init');

  // --- 2. 用界面添加一个接口 ---
  await js(`
    window.__t = {
      card: () => document.querySelector('.conn-card'),
      btn: (t) => [...document.querySelectorAll('.conn-card button')].find(b => b.textContent.includes(t)),
      all: () => [...document.querySelectorAll('.conn-card input, .conn-card select')],
    }; 'ok'`);
  check('settings.addButtonClicked', await js(
    "[...document.querySelectorAll('.modal-body button')].some(b => { if (b.textContent.includes('添加接口')) { b.click(); return true; } return false; })"
  ));
  await sleep(300);
  check('settings.cardExists', await js('!!window.__t.card()'));
  check('settings.fillResult', await js(`
    (() => {
      const ins = window.__t.card().querySelectorAll('input');
      const set = (e, v) => { e.value = v; e.dispatchEvent(new Event('input', {bubbles:true})); };
      set(ins[0], '本地模拟接口');
      set(ins[1], 'http://127.0.0.1:${port}/v1');
      set(ins[2], 'sk-test-key');
      set(ins[3], 'mock-model');
      return [...ins].map(i => i.value).join(' | ');
    })()`));
  await js('window.__t.btn("保存").click()');
  await sleep(250);
  await js('window.__t.btn("获取模型列表").click()');
  await sleep(700);
  check('models.datalistOptions', await js("document.querySelectorAll('.conn-card datalist option').length"));
  await js('window.__t.btn("设为当前").click()');
  await sleep(200);
  await js("document.querySelector('.modal-head [data-close]').click()");
  await sleep(300);
  check('settings.modalClosed', await js("!document.querySelector('.modal-mask')"));
  check('topbar.connectionName', await js("document.querySelector('#conn-select').selectedOptions[0] ? document.querySelector('#conn-select').selectedOptions[0].textContent : ''"));
  await shot('02-configured');

  // --- 3. 发一条消息，验证流式 ---
  await js(`(() => { const t = document.querySelector('#input'); t.value = '你好，测试一下流式输出'; t.dispatchEvent(new Event('input', {bubbles:true})); return t.value; })()`);
  await js("document.querySelector('#btn-send').click()");
  await sleep(800);
  check('stream.midflight.stopButton', await js("document.querySelector('#btn-send').textContent.includes('停止')"));
  check('stream.midflight.cursor', await js("!!document.querySelector('.cursor-blink')"));
  await shot('03-streaming');

  for (let i = 0; i < 100; i++) {
    const busy = await js("document.querySelector('#btn-send').textContent.includes('停止')");
    if (!busy) break;
    await sleep(200);
  }
  await sleep(400);
  check('chat.userMessages', await js("document.querySelectorAll('.msg-user').length"));
  check('chat.assistantMessages', await js("document.querySelectorAll('.msg-assistant').length"));
  check('chat.codeBlockRendered', await js("document.querySelectorAll('.msg-assistant .code-block').length"));
  check('chat.tableRendered', await js("document.querySelectorAll('.msg-assistant table').length"));
  check('chat.highlightedSpans', await js("document.querySelectorAll('.msg-assistant .hljs-keyword, .msg-assistant .hljs-title, .msg-assistant .hljs-built_in').length"));
  check('chat.hasError', await js("!!document.querySelector('.msg-error')"));
  check('sidebar.autoTitle', await js("document.querySelector('.conv-item .conv-name').textContent"));
  await shot('04-after-reply');

  // --- 4. 拖入图片 + 文本文件 ---
  const png = makePng(28, 28, [230, 80, 70, 255]).toString('base64');
  check('drop.attachments', await js(`
    (async () => {
      const b64 = ${JSON.stringify(png)};
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], 'circle.png', { type: 'image/png' });
      const note = new File(['这是一份测试文档的内容：你好，世界。'], 'note.txt', { type: 'text/plain' });
      const dt = new DataTransfer();
      dt.items.add(file);
      dt.items.add(note);
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 800));
      return {
        chips: document.querySelectorAll('#pending .att').length,
        thumbs: document.querySelectorAll('#pending .att-thumb img').length,
        names: [...document.querySelectorAll('#pending .att-name')].map(e => e.textContent),
      };
    })()`));
  await shot('05-attachments');

  // --- 5. 带附件再发一次，检查请求体里真的有图片 ---
  await js("document.querySelector('#btn-send').click()");
  for (let i = 0; i < 60; i++) {
    const busy = await js("document.querySelector('#btn-send').textContent.includes('停止')");
    if (!busy) break;
    await sleep(200);
  }
  await sleep(300);

  const chatReqs = state.requests.filter((r) => /chat\/completions/.test(r.url));
  const last = chatReqs[chatReqs.length - 1] || { body: {} };
  const lastUser = (last.body.messages || []).filter((m) => m.role === 'user').pop() || {};
  const parts = Array.isArray(lastUser.content) ? lastUser.content : [];
  check('request.count', chatReqs.length);
  check('request.model', last.body.model);
  check('request.hasSystemMessage', (last.body.messages || []).some((m) => m.role === 'system'));
  check('request.imagePartCount', parts.filter((p) => p.type === 'image_url').length);
  check('request.imageIsDataUrl', parts.some((p) => p.type === 'image_url' && /^data:image\/png;base64,/.test(p.image_url.url)));
  check('request.textIncludesFileContent', JSON.stringify(last.body).includes('你好，世界'));
  check('request.temperature', typeof last.body.temperature);
  check('sidebar.attachmentsShown', await js("document.querySelectorAll('.msg-user .att').length + document.querySelectorAll('.msg-user .att-thumb').length"));
  await shot('06-after-attachment-send');

  // --- 6. 重命名对话 ---
  check('rename.result', await js(`
    (async () => {
      const item = document.querySelector('.conv-item');
      item.querySelector('button[data-act=rename]').click();
      const input = item.querySelector('.conv-name input');
      if (!input) return 'no-input';
      input.value = '重命名后的对话';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      return document.querySelector('.conv-item .conv-name').textContent;
    })()`));
  await shot('07-renamed');

  // --- 7. 新建对话 + 删除对话 ---
  await js("document.querySelector('#btn-new').click()");
  await sleep(400);
  check('newConversation.count', await js("document.querySelectorAll('.conv-item').length"));
  check('newConversation.emptyState', await js("!!document.querySelector('.empty-state')"));
  await shot('08-new-conversation');

  check('delete.result', await js(`
    (async () => {
      window.confirm = () => true;
      const before = document.querySelectorAll('.conv-item').length;
      const first = document.querySelector('.conv-item');
      const name = first.querySelector('.conv-name').textContent;
      first.querySelector('button[data-act=delete]').click();
      await new Promise(r => setTimeout(r, 800));
      return {
        deleted: name,
        before,
        after: document.querySelectorAll('.conv-item').length,
        currentTitle: document.querySelector('#conv-title').value,
        messagesVisible: document.querySelectorAll('.msg').length,
        emptyState: !!document.querySelector('.empty-state'),
      };
    })()`));
  await shot('09-after-delete');

  // --- 8. 对话参数弹窗 ---
  await js("document.querySelector('#btn-conv-params').click()");
  await sleep(350);
  check('params.modalOpen', await js("!!document.querySelector('.modal-mask')"));
  check('params.saved', await js(`
    (async () => {
      const body = document.querySelector('.modal-body');
      const ta = body.querySelector('textarea');
      const num = body.querySelector('input[type=number]');
      ta.value = '你是一个测试用的助手，只回答 OK';
      num.value = '0.2';
      [...document.querySelectorAll('.modal-foot button')].find(b => b.textContent.includes('保存')).click();
      await new Promise(r => setTimeout(r, 400));
      const s = await window.api.getState();
      const conv = s.conversations.find(c => c.id === document.querySelector('.conv-item.active') ? true : false);
      return { anyConv: s.conversations.length, modalClosed: !document.querySelector('.modal-mask') };
    })()`));
  await shot('10-params');

  // --- 9. 主题切换 ---
  const THEME_PROBE = `(() => {
    const rgb = (s) => (String(s).match(/\\d+/g) || [0, 0, 0]).slice(0, 3).map(Number);
    const lum = (c) => {
      const f = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
      return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
    };
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100; };
    const bodyBg = rgb(getComputedStyle(document.body).backgroundColor);
    const bodyFg = rgb(getComputedStyle(document.body).color);
    const bubbleEl = document.querySelector('.msg-user .bubble');
    const codeEl = document.querySelector('.code-block');
    const codeFgEl = document.querySelector('.code-block .hljs');
    return {
      dataTheme: document.documentElement.dataset.theme,
      bodyBgLum: Math.round(lum(bodyBg) * 1000) / 1000,
      textContrast: ratio(bodyBg, bodyFg),
      bubbleContrast: bubbleEl ? ratio(rgb(getComputedStyle(bubbleEl).backgroundColor), bodyFg) : null,
      codeContrast: codeEl && codeFgEl ? ratio(rgb(getComputedStyle(codeEl).backgroundColor), rgb(getComputedStyle(codeFgEl).color)) : null,
      segActive: [...document.querySelectorAll('.seg button.on')].map((b) => b.textContent.trim()),
      themeBtnIcon: document.querySelector('#btn-theme').textContent,
    };
  })()`;

  await js("document.querySelector('#btn-settings').click()");
  await sleep(350);
  await js("document.querySelector('.modal-tabs button[data-tab=general]').click()");
  await sleep(300);

  const themeProbe = (label) => `(async () => {
    const btn = [...document.querySelectorAll('.seg button')].find(b => b.textContent.includes('${label}'));
    if (!btn) return { error: 'no-button' };
    btn.click();
    await new Promise(r => setTimeout(r, 350));
    const s = await window.api.getState();
    const p = ${THEME_PROBE};
    p.savedTheme = s.settings.theme;
    return p;
  })()`;

  const light = await js(themeProbe('浅色米白'));
  const nativeBgLight = String(win.getBackgroundColor() || '').toLowerCase();
  check('theme.light', light);
  check('theme.light.isWarmBright', light.bodyBgLum > 0.7);
  check('theme.light.contrastOk', light.textContrast >= 4.5 && light.bubbleContrast >= 4.5 && light.codeContrast >= 4.5);
  await shot('11-theme-light');

  const dark = await js(themeProbe('深色深绿'));
  const nativeBgDark = String(win.getBackgroundColor() || '').toLowerCase();
  check('theme.dark', dark);
  check('theme.dark.isDeep', dark.bodyBgLum < 0.15);
  check('theme.dark.contrastOk', dark.textContrast >= 4.5 && dark.bubbleContrast >= 4.5 && dark.codeContrast >= 4.5);
  // 窗口原生底色也要跟着换，否则浅色主题启动时会先闪一帧深色
  check('theme.nativeWindowBg', { light: nativeBgLight, dark: nativeBgDark });
  check('theme.nativeWindowBgTracksTheme', nativeBgLight === '#f8f5ed' && nativeBgDark === '#0b1210');
  await shot('12-theme-dark');

  check('theme.system', await js(themeProbe('跟随系统')));

  // 顶栏按钮一键切换
  const toggled = await js(`
    (async () => {
      const before = document.documentElement.dataset.theme;
      document.querySelector('#btn-theme').click();
      await new Promise(r => setTimeout(r, 350));
      const s = await window.api.getState();
      const toastEl = document.querySelector('#toast');
      return {
        before,
        after: document.documentElement.dataset.theme,
        flipped: before !== document.documentElement.dataset.theme,
        savedTheme: s.settings.theme,
        toast: toastEl.textContent,
        icon: document.querySelector('#btn-theme').textContent,
      };
    })()`);
  check('theme.toggleButton', toggled);
  check('theme.togglePersisted', toggled.flipped === true && toggled.savedTheme === toggled.after);

  // 回到浅色，后面用它验证「重启后首屏就是浅色、不闪深色」
  await js("(async () => { await window.api.updateSettings({ theme: 'light' }); })()");
  await sleep(300);
  await js("document.querySelector('.modal-head [data-close]').click()");
  await sleep(250);

  // 重新加载页面：preload 会在页面脚本之前同步取到 light 并写进 <html data-theme>
  await new Promise((resolve) => {
    win.webContents.once('did-finish-load', resolve);
    win.webContents.reload();
  });
  await sleep(900);
  const cold = await js(`({
    dataTheme: document.documentElement.dataset.theme,
    dataFrom: document.documentElement.dataset.themeFrom,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  })`);
  check('theme.coldStartNoFlash', cold);
  check('theme.preloadAppliedFirst', cold.dataTheme === 'light' && cold.dataFrom === 'preload');

  // --- 10. 数据目录（%APPDATA% 不可写时会兜底到程序目录） ---
  const dataDirUi = await js(`
    (async () => {
      const s = await window.api.getState();
      document.querySelector('#btn-settings').click();
      await new Promise(r => setTimeout(r, 350));
      document.querySelector('.modal-tabs button[data-tab=general]').click();
      await new Promise(r => setTimeout(r, 300));
      const pane = document.querySelector('.modal-body');
      const text = pane ? pane.textContent : '';
      document.querySelector('.modal-head [data-close]').click();
      return { dataDir: s.appInfo.dataDir, shown: text.indexOf('数据目录：' + s.appInfo.dataDir) >= 0 };
    })()`);
  check('appInfo.dataDir', dataDirUi);
  check('appInfo.dataDirShownInSettings', dataDirUi.shown === true);
  check('appInfo.dataDirHonoursOverride', !!process.env.BTC_USER_DATA &&
    path.resolve(String(dataDirUi.dataDir)) === path.resolve(process.env.BTC_USER_DATA));

  // --- 11. 重新回答 / 对话分支 ---
  // 回到有 AI 回答的那个对话
  const branchConvId = (await js(`(async () => {
    window.__t = window.__t || {};
    const s = await window.api.getState();
    const conv = s.conversations.find(c => c.messages.some(m => m.role === 'assistant')) || s.conversations[0];
    window.__t.branchConvId = conv.id;
    const item = document.querySelector('.conv-item[data-id="' + conv.id + '"]');
    if (item) item.click();
    await new Promise(r => setTimeout(r, 500));
    return conv.id;
  })()`)) || {};
  await sleep(400);

  const waitIdle = async () => {
    for (let i = 0; i < 100; i++) {
      const busy = await js("document.querySelector('#btn-send').textContent.includes('停止')");
      if (!busy) break;
      await sleep(200);
    }
    await sleep(400);
  };

  // 11.1 对最后一条回答点「重新回答」：应该多出一个版本，而不是把旧回答删掉
  const ReanswerTarget = (await js(`(async () => {
    window.__t = window.__t || {};
    const s = await window.api.getState();
    const conv = s.conversations.find(c => c.id === window.__t.branchConvId);
    const last = [...conv.messages].reverse().find(m => m.role === 'assistant' && !m.error);
    window.__t.reanswerId = last.id;
    window.__t.reanswerV0 = (last.variants && last.variants[0] ? last.variants[0].content : last.content) || '';
    const el = document.querySelector('.msg[data-id="' + last.id + '"]');
    el.querySelector('button[data-act=retry]').click();
    return { id: last.id, variantsBefore: (last.variants || []).length, msgCount: conv.messages.length };
  })()`)) || {};
  await sleep(700);
  check('branch.reanswerInFlight', await js("document.querySelector('#btn-send').textContent.includes('停止')"));

  // 生成中点 ‹ ：必须被挡住，否则正在流式写入的内容会写进被切过去的那一版
  const switchDuringStream = (await js(`(async () => {
    window.__t = window.__t || {};
    const s = await window.api.getState();
    const conv = s.conversations.find(c => c.id === window.__t.branchConvId);
    const before = conv.messages.find(m => m.id === window.__t.reanswerId).activeVariant;
    const el = document.querySelector('.msg[data-id="' + window.__t.reanswerId + '"]');
    const btn = el.querySelector('button[data-act=var-prev]');
    const clicked = !!btn;
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 350));
    const s2 = await window.api.getState();
    const conv2 = s2.conversations.find(c => c.id === window.__t.branchConvId);
    return {
      before,
      after: conv2.messages.find(m => m.id === window.__t.reanswerId).activeVariant,
      clicked,
      toast: document.querySelector('#toast').textContent,
    };
  })()`)) || {};
  check('branch.switchBlockedWhileStreaming', switchDuringStream.clicked === true &&
    switchDuringStream.before === switchDuringStream.after);
  check('branch.switchBlockedToast', String(switchDuringStream.toast).includes('生成中'));

  await shot('14-reanswering');
  await waitIdle();

  const afterReanswer = (await js(`(async () => {
    window.__t = window.__t || {};
    const s = await window.api.getState();
    const conv = s.conversations.find(c => c.id === window.__t.branchConvId);
    const m = conv.messages.find(x => x.id === window.__t.reanswerId);
    const el = document.querySelector('.msg[data-id="' + m.id + '"]');
    const pos = el.querySelector('.variant-pos');
    return {
      total: m.variants.length,
      active: m.activeVariant,
      msgCount: conv.messages.length,
      bar: pos ? pos.textContent : null,
      bubble: el.querySelector('.bubble').textContent.trim().slice(0, 24),
      // 比对只用开头 6 个字：后面的 **粗体** 渲染后会掉星号，raw 与 textContent 本来就不相等
      bubbleHead: el.querySelector('.bubble').textContent.trim().slice(0, 6),
      v0: (m.variants[0].content || '').slice(0, 24),
      v1: (m.variants[1].content || '').slice(0, 24),
      v0Head: (m.variants[0].content || '').slice(0, 6),
      v1Head: (m.variants[1].content || '').slice(0, 6),
      keptOld: m.variants[0].content === window.__t.reanswerV0,
      errored: !!m.error,
    };
  })()`)) || {};
  check('branch.msgCountUnchanged', afterReanswer.msgCount === ReanswerTarget.msgCount);
  check('branch.reanswerVariants', afterReanswer.total === ReanswerTarget.variantsBefore + 1);
  check('branch.reanswerActive', afterReanswer.active === 1);
  check('branch.barShows2of2', afterReanswer.bar === '2/2');
  check('branch.oldAnswerKept', afterReanswer.keptOld === true);
  check('branch.newAnswerDiffers', afterReanswer.v0Head !== afterReanswer.v1Head && afterReanswer.v1.length > 0);
  check('branch.newAnswerShown', afterReanswer.bubbleHead === afterReanswer.v1Head);
  check('branch.reanswerNoError', afterReanswer.errored === false);
  await shot('15-reanswer-2of2');

  // 11.1b 版本切换器的可见性 / 对比度：它是常驻显示的（不靠 hover 才出现），不能只是"存在"
  const barStyle = (await js(`(() => {
    window.__t = window.__t || {};
    const el = document.querySelector('.msg[data-id="' + window.__t.reanswerId + '"]');
    const bar = el.querySelector('.variant-bar');
    const pos = bar.querySelector('.variant-pos');
    const btn = bar.querySelector('button[data-act=var-next]');
    const r = bar.getBoundingClientRect();
    const cs = getComputedStyle(bar);
    const toRgb = (c) => (c.match(/\\d+(\\.\\d+)?/g) || [0, 0, 0]).map(Number);
    const lum = (c) => {
      const m = toRgb(c);
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
    };
    const ratio = (a, b) => {
      const l1 = lum(a), l2 = lum(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const bg = getComputedStyle(document.body).backgroundColor;
    const br = btn.getBoundingClientRect();
    return {
      display: cs.display,
      opacity: cs.opacity,
      width: Math.round(r.width),
      height: Math.round(r.height),
      posText: pos.textContent,
      posColor: getComputedStyle(pos).color,
      btnW: Math.round(br.width),
      btnH: Math.round(br.height),
      contrast: Number(ratio(getComputedStyle(pos).color, bg).toFixed(2)),
    };
  })()`)) || {};
  check('branch.barVisibleWithoutHover', barStyle);
  check('branch.barAlwaysVisible', barStyle.display !== 'none' && Number(barStyle.opacity) > 0.9 &&
    barStyle.width > 30 && barStyle.height > 8 && barStyle.posText === '2/2');
  check('branch.barButtonClickable', barStyle.btnW >= 12 && barStyle.btnH >= 12);
  check('branch.barContrast', barStyle.contrast >= 4.5);

  // 11.2 用 ‹ 切回第 1 版：应该还原成旧回答，且没有丢版本
  const backToOne = (await js(`(async () => {
    window.__t = window.__t || {};
    const el = document.querySelector('.msg[data-id="' + window.__t.reanswerId + '"]');
    el.querySelector('button[data-act=var-prev]').click();
    await new Promise(r => setTimeout(r, 400));
    const s = await window.api.getState();
    const conv = s.conversations.find(c => c.id === window.__t.branchConvId);
    const m = conv.messages.find(x => x.id === window.__t.reanswerId);
    const el2 = document.querySelector('.msg[data-id="' + m.id + '"]');
    return {
      active: m.activeVariant,
      total: m.variants.length,
      bar: el2.querySelector('.variant-pos').textContent,
      bubble: el2.querySelector('.bubble').textContent.trim().slice(0, 24),
      bubbleHead: el2.querySelector('.bubble').textContent.trim().slice(0, 6),
      v0: (m.variants[0].content || '').slice(0, 24),
      v0Head: (m.variants[0].content || '').slice(0, 6),
    };
  })()`)) || {};
  check('branch.backToOneActive', backToOne.active === 0);
  check('branch.backToOneBar', backToOne.bar === '1/2');
  check('branch.backToOneText', backToOne.bubbleHead === backToOne.v0Head);
  check('branch.backToOneKeepsBoth', backToOne.total === 2);
  await shot('16-branch-back-to-1');

  // 11.3 编辑自己的提问：提问开新分支，紧随其后的回答也跟着开新分支
  const editTarget = (await js(`(async () => {
    window.__t = window.__t || {};
    const s = await window.api.getState();
    const conv = s.conversations.find(c => c.id === window.__t.branchConvId);
    const user = conv.messages.find(m => m.role === 'user');
    const at = conv.messages.findIndex(m => m.id === user.id);
    const ai = conv.messages[at + 1];
    window.__t.editUserId = user.id;
    window.__t.editAiId = ai.id;
    window.__t.oldQuestionText = user.content;
    window.__t.oldAnswerText = ai.content.slice(0, 24);
    const el = document.querySelector('.msg[data-id="' + user.id + '"]');
    el.querySelector('button[data-act=edit]').click();
    await new Promise(r => setTimeout(r, 250));
    const ta = el.querySelector('.edit-input');
    const opened = !!ta;
    if (ta) {
      ta.value = '改写后的问题：请只回答一个词';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      el.querySelector('button[data-act=edit-save]').click();
    }
    return { opened, oldQuestion: user.content, oldAnswer: ai.content.slice(0, 24) };
  })()`)) || {};
  check('branch.editBoxOpened', editTarget.opened === true);
  await sleep(700);
  await waitIdle();

  const afterEdit = (await js(`(async () => {
    window.__t = window.__t || {};
    const s = await window.api.getState();
    const conv = s.conversations.find(c => c.id === window.__t.branchConvId);
    const u = conv.messages.find(m => m.id === window.__t.editUserId);
    const a = conv.messages.find(m => m.id === window.__t.editAiId);
    const uEl = document.querySelector('.msg[data-id="' + u.id + '"]');
    const aEl = document.querySelector('.msg[data-id="' + a.id + '"]');
    const pos = (el) => { const p = el.querySelector('.variant-pos'); return p ? p.textContent : null; };
    return {
      title: conv.title,
      userVariants: u.variants.length,
      userActive: u.activeVariant,
      userBar: pos(uEl),
      userBubble: uEl.querySelector('.bubble').textContent.trim(),
      oldQuestionKept: u.variants[0].content === window.__t.oldQuestionText,
      editBoxGone: !uEl.querySelector('.edit-box'),
      aiVariants: a.variants.length,
      aiActive: a.activeVariant,
      aiBar: pos(aEl),
      aiOldKept: a.variants[0].content.slice(0, 24) === window.__t.oldAnswerText,
      aiBubble: aEl.querySelector('.bubble').textContent.trim().slice(0, 24),
      aiBubbleHead: aEl.querySelector('.bubble').textContent.trim().slice(0, 6),
      aiNew: (a.variants[1] ? a.variants[1].content : '').slice(0, 24),
      aiNewHead: (a.variants[1] ? a.variants[1].content : '').slice(0, 6),
    };
  })()`)) || {};
  check('branch.editUserVariants', afterEdit.userVariants === 2);
  check('branch.editUserBar', afterEdit.userBar === '2/2');
  check('branch.editUserText', afterEdit.userBubble === '改写后的问题：请只回答一个词');
  check('branch.editKeepsOldQuestion', afterEdit.oldQuestionKept === true);
  check('branch.editBoxClosed', afterEdit.editBoxGone === true);
  check('branch.editAnswerVariants', afterEdit.aiVariants === 2);
  check('branch.editAnswerBar', afterEdit.aiBar === '2/2');
  check('branch.editKeepsOldAnswer', afterEdit.aiOldKept === true);
  check('branch.editGeneratedNewAnswer', afterEdit.aiBubbleHead === afterEdit.aiNewHead && afterEdit.aiNew !== editTarget.oldAnswer);
  check('branch.editUpdatesTitle', afterEdit.title === '改写后的问题：请只回答一个词');
  await shot('17-edited-question-branch');

  // 编辑后的请求体里应该是新提问，且不再带旧提问
  const branchReq = state.requests.filter((r) => /chat\/completions/.test(r.url)).pop() || { body: {} };
  const branchReqText = JSON.stringify(branchReq.body);
  check('branch.requestUsesNewQuestion', branchReqText.includes('改写后的问题'));
  check('branch.requestDropsOldQuestion', !branchReqText.includes('你好，测试一下流式输出'));

  // 11.4 切提问的版本：后面的回答成对齐到同一版本号
  const pairSwitch = (await js(`(async () => {
    window.__t = window.__t || {};
    const el = document.querySelector('.msg[data-id="' + window.__t.editUserId + '"]');
    el.querySelector('button[data-act=var-prev]').click();
    await new Promise(r => setTimeout(r, 400));
    const s = await window.api.getState();
    const conv = s.conversations.find(c => c.id === window.__t.branchConvId);
    const u = conv.messages.find(m => m.id === window.__t.editUserId);
    const a = conv.messages.find(m => m.id === window.__t.editAiId);
    return {
      userActive: u.activeVariant,
      userText: u.content,
      aiActive: a.activeVariant,
      aiFirst: (a.variants[0].content || '').slice(0, 24),
      aiFirstHead: (a.variants[0].content || '').slice(0, 6),
      aiBubble: document.querySelector('.msg[data-id="' + a.id + '"] .bubble').textContent.trim().slice(0, 24),
      aiBubbleHead: document.querySelector('.msg[data-id="' + a.id + '"] .bubble').textContent.trim().slice(0, 6),
    };
  })()`)) || {};
  check('branch.pairSwitchUserBack', pairSwitch.userActive === 0 && pairSwitch.userText === editTarget.oldQuestion);
  check('branch.pairSwitchAnswerFollows', pairSwitch.aiActive === 0);
  check('branch.pairSwitchAnswerText', pairSwitch.aiBubbleHead === pairSwitch.aiFirstHead);
  await shot('18-pair-switch');

  // 11.5 旧数据兼容：老消息被自动补成单版本
  check('branch.legacyMessagesHaveVariants', await js(`(async () => {
    const s = await window.api.getState();
    const conv = s.conversations.find(c => c.id === window.__t.branchConvId);
    return conv.messages.every(m => Array.isArray(m.variants) && m.variants.length >= 1 && typeof m.activeVariant === 'number');
  })()`));

  // --- 12. 持久化检查 ---
  const persisted = await js(`(async () => {
    const s = await window.api.getState();
    const conv = s.conversations.find(c => c.title === '重命名后的对话') || s.conversations[0];
    return {
      conversations: s.conversations.length,
      connections: s.connections.map(c => ({ name: c.name, type: c.type, baseUrl: c.baseUrl, model: c.model, hasKey: !!c.apiKey })),
      activeConnectionId: !!s.activeConnectionId,
      title: conv ? conv.title : null,
      systemPromptChanged: conv ? conv.systemPrompt.includes('只回答 OK') : false,
      temperature: conv ? conv.temperature : null,
      theme: s.settings.theme,
      messages: conv ? conv.messages.map(m => ({ role: m.role, len: (m.content || '').length, atts: (m.attachments || []).length, error: m.error || null })) : [],
    };
  })()`);
  check('persisted.state', persisted);
  await shot('13-after-reload');

  report.mockRequestCount = state.requests.length;
  report.rendererLogs = globalThis.__smokeLogs || [];
  server.close();

  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(path.join(__dirname, '..', 'smoke-output.txt'), JSON.stringify(report, null, 2), 'utf8');

  console.log('\n===== SMOKE REPORT =====');
  console.log(JSON.stringify(report, null, 2));
  console.log('===== END =====\n');
  console.log('截图目录: ' + outDir);
  app.quit();
};
