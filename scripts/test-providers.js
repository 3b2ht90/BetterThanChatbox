'use strict';

// provider 层单元测试（不依赖 Electron）：用假接口验证三种协议的请求构造与流式解析。
// 用法： node scripts/test-providers.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const providers = require('../app/lib/providers');
const md = require('../app/lib/markdown');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    failures.push(name + (extra ? ' -> ' + JSON.stringify(extra) : ''));
    console.log('  ✗ ' + name + (extra ? ' -> ' + JSON.stringify(extra) : ''));
  }
}

function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 假接口 ----------
const captured = {};

function sseWrite(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        const key = req.url.split('?')[0];
        captured[key] = { headers: req.headers, body: parsed };

        if (req.url.includes('promptFeedbackOnly')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          sseWrite(res, { promptFeedback: { blockReason: 'SAFETY' } });
          res.end();
          return;
        }
        if (/\/models(\?|$)/.test(req.url)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          if (req.url.includes('generativelanguage') || req.url.includes('v1beta')) {
            res.end(JSON.stringify({ models: [{ name: 'models/gemini-x' }, { name: 'models/gemini-y' }] }));
          } else if (req.url.includes('/v1/messages') || req.headers['x-api-key']) {
            res.end(JSON.stringify({ data: [{ id: 'claude-x' }] }));
          } else {
            res.end(JSON.stringify({ data: [{ id: 'gpt-x' }, { id: 'gpt-y' }] }));
          }
          return;
        }
        if (req.url.includes('/error401')) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid API key provided' } }));
          return;
        }

        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.flushHeaders();
        const isAnthropic = req.url.includes('/messages');
        const isGemini = req.url.includes(':streamGenerateContent');
        let i = 0;
        const chunks = ['你', '好', '，世界'];
        const timer = setInterval(() => {
          if (i >= chunks.length) {
            clearInterval(timer);
            if (!isAnthropic && !isGemini) res.write('data: [DONE]\n\n');
            if (isAnthropic) sseWrite(res, { type: 'message_stop' });
            res.end();
            return;
          }
          if (isAnthropic) {
            sseWrite(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunks[i] } });
          } else if (isGemini) {
            sseWrite(res, { candidates: [{ content: { parts: [{ text: chunks[i] }] } }] });
          } else {
            sseWrite(res, { choices: [{ index: 0, delta: { content: chunks[i] } }] });
          }
          i++;
        }, 60);
        // 注意：不能用 req.on('close')——Node 16+ 在请求体读完后就会触发，会把定时器清掉
        res.on('close', () => clearInterval(timer));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------- 测试素材 ----------
function makePng() {
  const w = 4;
  const h = 4;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = 10; raw[o + 1] = 200; raw[o + 2] = 10; raw[o + 3] = 255;
    }
  }
  let table = null;
  const crc32 = (buf) => {
    if (!table) {
      table = new Int32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
    }
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([l, t, data, cr]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  const server = await startMock();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const tmp = path.join(__dirname, '..', '.test-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const imgPath = path.join(tmp, 'pic.png');
  fs.writeFileSync(imgPath, makePng());

  const imageAtt = { kind: 'image', mime: 'image/png', path: imgPath, name: 'pic.png', size: 100 };
  const textAtt = { kind: 'text', name: 'a.txt', text: '文件内容HELLO', size: 10 };
  const pdfAtt = { kind: 'pdf', name: 'b.pdf', text: 'PDF正文', size: 10 };
  const binAtt = { kind: 'other', name: 'c.zip', size: 2048 };

  console.log('\n[1] OpenAI 兼容');
  {
    const conn = { type: 'openai', baseUrl: base + '/v1', apiKey: 'sk-x', model: 'gpt-test' };
    const deltas = [];
    const res = await providers.streamChat({
      connection: conn,
      model: '',
      systemPrompt: '你是助手',
      temperature: 0.3,
      messages: [
        { role: 'user', content: '你好', attachments: [imageAtt, textAtt, pdfAtt, binAtt] },
        { role: 'assistant', content: '在的' },
        { role: 'user', content: '继续' },
      ],
      onDelta: (d) => deltas.push(d),
    });
    eq('拼接后的完整文本', res.text, '你好，世界');
    eq('流式回调分片', deltas, ['你', '好', '，世界']);
    const sent = captured['/v1/chat/completions'].body;
    eq('model', sent.model, 'gpt-test');
    eq('stream', sent.stream, true);
    eq('temperature', sent.temperature, 0.3);
    eq('system message', sent.messages[0], { role: 'system', content: '你是助手' });
    const u = sent.messages[1];
    ok('user content 是数组（含图片）', Array.isArray(u.content));
    eq('图片分块数', u.content.filter((p) => p.type === 'image_url').length, 1);
    ok('图片是 data URL', /^data:image\/png;base64,/.test(u.content.find((p) => p.type === 'image_url').image_url.url));
    const joined = JSON.stringify(sent.messages);
    ok('文本附件内容注入', joined.includes('文件内容HELLO'));
    ok('PDF 文本注入', joined.includes('PDF正文'));
    ok('二进制附件只提示文件名', joined.includes('c.zip') && joined.includes('无法解析'));
    eq('鉴权头', captured['/v1/chat/completions'].headers.authorization, 'Bearer sk-x');
  }

  console.log('\n[2] Anthropic');
  {
    const conn = { type: 'anthropic', baseUrl: base, apiKey: 'sk-ant', model: 'claude-test' };
    const deltas = [];
    const res = await providers.streamChat({
      connection: conn,
      systemPrompt: '你是助手',
      temperature: 0.5,
      messages: [{ role: 'user', content: '你好', attachments: [imageAtt] }],
      onDelta: (d) => deltas.push(d),
    });
    eq('文本', res.text, '你好，世界');
    eq('分片', deltas, ['你', '好', '，世界']);
    const sent = captured['/v1/messages'].body;
    eq('system 字段', sent.system, '你是助手');
    eq('max_tokens 存在', typeof sent.max_tokens, 'number');
    const blocks = sent.messages[0].content;
    ok('包含 image block', blocks.some((b) => b.type === 'image' && b.source.type === 'base64' && b.source.media_type === 'image/png'));
    ok('包含 text block', blocks.some((b) => b.type === 'text'));
    eq('x-api-key 头', captured['/v1/messages'].headers['x-api-key'], 'sk-ant');
    eq('anthropic-version 头', captured['/v1/messages'].headers['anthropic-version'], '2023-06-01');
  }

  console.log('\n[3] Gemini');
  {
    const conn = { type: 'gemini', baseUrl: base, apiKey: 'g-key', model: 'gemini-test' };
    const deltas = [];
    const res = await providers.streamChat({
      connection: conn,
      systemPrompt: '你是助手',
      temperature: 0.9,
      messages: [{ role: 'user', content: '你好', attachments: [imageAtt] }],
      onDelta: (d) => deltas.push(d),
    });
    eq('文本', res.text, '你好，世界');
    const sent = captured['/v1beta/models/gemini-test:streamGenerateContent'].body;
    eq('system_instruction', sent.system_instruction, { parts: [{ text: '你是助手' }] });
    eq('temperature', sent.generationConfig.temperature, 0.9);
    const parts = sent.contents[0].parts;
    ok('inline_data 图片', parts.some((p) => p.inline_data && p.inline_data.mime_type === 'image/png'));
    ok('文本 part', parts.some((p) => typeof p.text === 'string'));
    eq('api key 头', captured['/v1beta/models/gemini-test:streamGenerateContent'].headers['x-goog-api-key'], 'g-key');
  }

  console.log('\n[4] 错误处理');
  {
    const conn = { type: 'openai', baseUrl: base + '/error401', apiKey: 'bad', model: 'm' };
    let msg = '';
    try {
      await providers.streamChat({ connection: conn, messages: [{ role: 'user', content: 'hi' }] });
    } catch (e) {
      msg = e.message;
    }
    ok('401 报错包含服务端信息', msg.includes('401') && msg.includes('Invalid API key'), msg);
  }
  {
    const conn = { type: 'openai', baseUrl: 'http://127.0.0.1:59997/v1', apiKey: 'x', model: 'm' };
    let msg = '';
    try {
      await providers.streamChat({ connection: conn, messages: [{ role: 'user', content: 'hi' }] });
    } catch (e) {
      msg = e.message;
    }
    ok('连接被拒绝时给出中文提示', msg.includes('连接被拒绝'), msg);
  }

  console.log('\n[5] 模型列表');
  {
    const ids1 = await providers.listModels({ type: 'openai', baseUrl: base + '/v1', apiKey: 'k' });
    eq('openai 模型', ids1, ['gpt-x', 'gpt-y']);
    const ids2 = await providers.listModels({ type: 'anthropic', baseUrl: base + '/v1/messages', apiKey: 'k' });
    eq('anthropic 模型', ids2, ['claude-x']);
    const ids3 = await providers.listModels({ type: 'gemini', baseUrl: base, apiKey: 'k' });
    eq('gemini 模型', ids3, ['gemini-x', 'gemini-y']);
  }

  console.log('\n[6] Base URL 归一化');
  {
    eq('openai 默认补 /v1', providers.openaiEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
    eq('openai 已带 /v1', providers.openaiEndpoint('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1/chat/completions');
    eq('openai 完整地址', providers.openaiEndpoint('https://x.com/v1/chat/completions'), 'https://x.com/v1/chat/completions');
    eq('openai 结尾斜杠', providers.openaiEndpoint('https://x.com/v1/'), 'https://x.com/v1/chat/completions');
    eq('anthropic 默认', providers.anthropicEndpoint(''), 'https://api.anthropic.com/v1/messages');
    eq('anthropic 已带 v1', providers.anthropicEndpoint('https://proxy.com/v1'), 'https://proxy.com/v1/messages');
    eq('gemini 默认', providers.geminiEndpoint('', 'gemini-2.0-flash', true),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse');
  }

  console.log('\n[7] Markdown 渲染');
  {
    const html = md.render('# 标题\n\n```js\nconst a = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n**粗体** [链接](https://a.com)');
    ok('标题', html.includes('<h1'));
    ok('代码块包装', html.includes('class="code-block"'));
    ok('语法高亮 span', html.includes('hljs-keyword'));
    ok('表格', html.includes('<table>'));
    ok('粗体', html.includes('<strong>'));
    ok('外链带 target', html.includes('target="_blank"'));
  }
  {
    const evil = md.render('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[点我](javascript:alert(3))');
    ok('去掉 script 标签', !/<script/i.test(evil));
    ok('去掉 onerror', !/onerror/i.test(evil));
    ok('去掉 javascript: 链接', !/javascript:/i.test(evil));
  }

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
  if (failures.length) {
    console.log('失败项：\n - ' + failures.join('\n - '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
