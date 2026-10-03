'use strict';

// 「发一个文件夹路径 → AI 读里面的文档 → 一键保存回该文件夹」的端到端测试驱动。
// 由主进程 require 后调用，参数是 (win, app)。
//
// 这条测试覆盖用户实际要走的路：
//   1. 驱动在磁盘上造一个文件夹，里面放几个文档
//   2. 起一个假的 OpenAI 兼容服务，把收到的请求体录下来
//   3. 在界面输入框里真的敲进那个文件夹路径 → 等界面认出路径并显示提示条
//   4. 点发送 → 检查发给 AI 的请求体里确实带着文档正文
//   5. 点 AI 回复上的「保存到 xxx/」→ 检查文件夹里真的多了一个 .md 文件
//
// 用法见 scripts/run-local-e2e.mjs

const http = require('http');
const path = require('path');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等条件成立，别用固定 sleep 赌时机（冷启动时 IPC 会明显变慢） */
async function waitFor(js, code, timeoutMs = 8000, stepMs = 250) {
  const t0 = Date.now();
  for (;;) {
    const v = await js(code);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(stepMs);
  }
}

const FOLDER_NAME = '测试文档';
const MARKER = 'E2E-文件夹标记-7413';
const REPLY = '# 文档摘要\n\n这个文件夹里有一份说明和一个代码文件。\n\n- 共 2 个可读文件\n';
const SERVED_MODELS = ['e2e-model-a'];

module.exports = async function localFileE2E(win, app) {
  const checks = [];
  const check = (name, pass, extra) => {
    checks.push({ name, pass: !!pass, extra: extra === undefined ? null : String(extra) });
    console.log((pass ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined && !pass ? '  → ' + extra : ''));
  };
  const js = (code) => win.webContents.executeJavaScript(code, true);

  // ---------- 造一个文件夹 ----------
  const base = path.join(app.getPath('userData'), FOLDER_NAME);
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(path.join(base, 'src'), { recursive: true });
  fs.writeFileSync(path.join(base, '说明.md'), `# 说明\n\n${MARKER}\n这是用来测试文件夹读取的说明文件。\n`, 'utf8');
  fs.writeFileSync(path.join(base, 'src', 'main.js'), 'function hello() { return "来自代码文件的内容"; }\n', 'utf8');
  fs.writeFileSync(path.join(base, 'data.bin'), Buffer.from([0, 1, 2, 3, 0, 0]));
  fs.mkdirSync(path.join(base, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(base, 'node_modules', 'junk.js'), 'should NOT be read\n', 'utf8');
  fs.writeFileSync(path.join(base, 'logo.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  console.log('测试文件夹：' + base);

  // ---------- 假接口 ----------
  const captured = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: SERVED_MODELS.map((id) => ({ id })) }));
      return;
    }
    if (req.url.startsWith('/v1/chat/completions')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { captured.push(JSON.parse(body)); } catch { captured.push({ raw: body }); }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // 分几块吐出来，顺便验证流式拼接
        const chunks = REPLY.match(/[\s\S]{1,20}/g) || [REPLY];
        for (const c of chunks) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: c } }] }) + '\n\n');
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

  // ---------- 把保存对话框换成假的（指到测试文件夹里） ----------
  const { dialog } = require('electron');
  const saveCalls = [];
  const savedTarget = path.join(base, '总结-e2e.md');
  dialog.showSaveDialog = async (_w, opts) => {
    saveCalls.push({ title: opts.title, defaultPath: opts.defaultPath });
    return { canceled: false, filePath: savedTarget };
  };
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });

  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  await sleep(1500);

  try {
    // ---------- 准备接口与对话 ----------
    const setup = await js(`(async () => {
      const s = await window.api.getState();
      for (const c of s.connections) await window.api.deleteConnection(c.id);
      const conn = await window.api.addConnection({
        name: 'E2E接口', type: 'openai', baseUrl: ${JSON.stringify(baseUrl)},
        apiKey: 'sk-fake', model: ${JSON.stringify(SERVED_MODELS[0])}
      });
      await window.api.setActiveConnection(conn.id);
      let conv = s.conversations[0];
      if (!conv) conv = await window.api.createConversation({ connectionId: conn.id });
      await window.api.updateConversation(conv.id, { connectionId: conn.id, title: '本地文档测试' });
      return { convId: conv.id };
    })()`);
    check('准备了指向假接口的对话', !!(setup && setup.convId));

    win.webContents.reload();
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await sleep(1800);

    // ---------- 输入框里敲文件夹路径 ----------
    // 故意用「中文紧贴路径、完全不加空格」的写法 —— 中文本来就不写空格，
    // 这正是最容易翻车的写法（路径的起点和终点都可能切错）。
    console.log('\n输入框里发一个文件夹路径（中文紧贴、无空格）');
    await js(`(() => {
      const i = document.querySelector('#input');
      i.value = '读取' + ${JSON.stringify(base)} + '里的内容';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor(js, `!!document.querySelector('#path-chips .path-chip')`, 8000);

    const chip = await js(`(() => {
      const box = document.querySelector('#path-chips');
      const chip = box ? box.querySelector('.path-chip') : null;
      return {
        hidden: box ? box.classList.contains('hidden') : true,
        exists: !!chip,
        name: chip ? chip.querySelector('.pc-name').textContent : null,
        meta: chip ? chip.querySelector('.pc-meta').textContent : null,
        blocked: chip ? chip.classList.contains('blocked') : null,
        hasRemove: chip ? !!chip.querySelector('.pc-x') : false,
      };
    })()`);
    check('界面上出现了「将读取」提示条', chip.exists && !chip.hidden, JSON.stringify(chip));
    check('提示条显示文件夹名', chip.name === FOLDER_NAME + '/', chip.name);
    check('提示条写明可读文件数与大小，并说明发送时读取', /个可读文件/.test(chip.meta || '') && /发送时读取/.test(chip.meta || ''), chip.meta);
    check('不是被拦的路径', chip.blocked === false);
    check('可以点 ✕ 取消读取', chip.hasRemove);

    // 顺带验证「路径不存在时会明确提示」，而不是默默不发
    console.log('\n路径不存在时要明确提示');
    await js(`(() => {
      const i = document.querySelector('#input');
      i.value = '读取 Z:\\\\这个盘不存在\\\\abc 里的内容';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor(js, `!!document.querySelector('#path-chips .path-chip.blocked')`, 8000);
    const missingChip = await js(`(() => {
      const c = document.querySelector('#path-chips .path-chip.blocked');
      return c ? { name: c.querySelector('.pc-name').textContent, meta: c.querySelector('.pc-meta').textContent } : null;
    })()`);
    check('不存在的路径显示为警告提示条', !!missingChip, JSON.stringify(missingChip));
    check('提示里说明了「找不到」', !!missingChip && /找不到/.test(missingChip.meta || ''), missingChip && missingChip.meta);

    // 恢复成正确的路径再发送
    await js(`(() => {
      const i = document.querySelector('#input');
      i.value = '读取' + ${JSON.stringify(base)} + '里的内容';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor(js, `(() => {
      const c = document.querySelector('#path-chips .path-chip');
      return c && !c.classList.contains('blocked') ? 1 : 0;
    })()`, 8000);

    // ---------- 发送 ----------
    console.log('\n点发送');
    await js(`document.querySelector('#btn-send').click(); true`);
    await sleep(2500);

    const body = captured[captured.length - 1];
    const sentText = (() => {
      const m = (body.messages || []).find((x) => x.role === 'user');
      if (!m) return '';
      return typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join('');
    })();
    check('请求确实发出去了', !!body, JSON.stringify(captured).slice(0, 200));
    check('请求体里带着文件夹正文（说明.md 的标记）', sentText.includes(MARKER), sentText.slice(0, 200));
    check('请求体里带着子目录里的代码文件', sentText.includes('来自代码文件的内容'));
    check('带上了文件夹概览头（含跳过项）', sentText.includes('未提供正文的条目'));
    check('跳过 node_modules 的说明也在', /node_modules/.test(sentText), '');
    check('用户自己的提问原样也在（中文紧贴路径也照发）',
      sentText.includes('读取' + base) && sentText.includes('里的内容'), sentText.slice(0, 120));

    const att = await js(`(() => {
      const el = document.querySelector('#messages .atts .att');
      return el ? el.textContent : null;
    })()`);
    check('消息上显示了文件夹附件（带文件数）', /测试文档\//.test(att || '') && /个文件/.test(att || ''), att);

    // ---------- 保存回该文件夹 ----------
    console.log('\n点「保存到该文件夹」');
    const saveBtn = await js(`(() => {
      const b = document.querySelector('#messages .msg-tools button[data-act="save"]');
      return b ? b.textContent.trim() : null;
    })()`);
    check('AI 回复上有保存按钮，且标出目标文件夹', saveBtn && saveBtn.includes('保存到 ' + FOLDER_NAME + '/'), saveBtn);

    await js(`(() => {
      const b = document.querySelector('#messages .msg-tools button[data-act="save"]');
      if (b) b.click();
      return true;
    })()`);
    await sleep(1200);

    check('保存对话框被调起，标题带目标文件夹名',
      saveCalls.some((c) => /测试文档/.test(c.title || '')), JSON.stringify(saveCalls.map((c) => c.title)));
    check('默认保存位置就在那个文件夹里（按对话标题命名 + 日期）',
      saveCalls[0] && path.dirname(saveCalls[0].defaultPath) === base,
      saveCalls[0] && saveCalls[0].defaultPath);
    check('文件真的写进了那个文件夹', fs.existsSync(savedTarget));
    if (fs.existsSync(savedTarget)) {
      const content = fs.readFileSync(savedTarget, 'utf8');
      check('写进去的是 AI 的完整回答', content.includes('# 文档摘要') && content.includes('共 2 个可读文件'), content.slice(0, 60));
    }
    const files = fs.readdirSync(base);
    check('文件夹里现在多了这个总结文件', files.includes('总结-e2e.md'), files.join(','));

    // 截图存档
    try {
      const shotDir = path.join(app.getPath('userData'), 'local-e2e-out');
      fs.mkdirSync(shotDir, { recursive: true });
      win.setAlwaysOnTop(true);
      win.focus();
      await sleep(800);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(shotDir, 'folder-summary.png'), img.toPNG());
      win.setAlwaysOnTop(false);
      console.log('  （截图：' + path.join(shotDir, 'folder-summary.png') + '）');
    } catch (err) {
      console.log('  （截图失败，不影响测试：' + err.message + '）');
    }
  } catch (err) {
    check('驱动自身没有抛异常', false, err.message + '\n' + (err.stack || ''));
  } finally {
    server.close();
  }

  const failed = checks.filter((c) => !c.pass);
  const outDir = path.join(app.getPath('userData'), 'local-e2e-out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'e2e-report.json'), JSON.stringify({
    suite: 'local-file-e2e', total: checks.length, failed: failed.length, checks,
  }, null, 2), 'utf8');
  console.log('\n本地文档端到端：共 ' + checks.length + ' 项，失败 ' + failed.length + ' 项');
  if (failed.length) throw new Error(failed.length + ' 项检查未通过：' + failed.map((f) => f.name).join('、'));
};
