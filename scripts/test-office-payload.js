'use strict';

// 端到端验证：docx 的内容到底有没有真正发到 AI 那边。
//
// 做法：把 global.fetch 换成一个假的，捕获三种协议真实发出去的请求体，
// 断言 docx 的正文出现在里面（而不是只有文件名）。
//
// 用法： node scripts/test-office-payload.js [样本目录]

const fs = require('fs');
const path = require('path');

const attachments = require('../app/lib/attachments');
const providers = require('../app/lib/providers');

const dir = process.argv[2] || path.join(__dirname, '..', 'test-artifacts', 'office');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''));
  }
}

// ---------- 造一条带 docx 附件的用户消息 ----------
const docxPath = path.join(dir, 'sample.docx');
if (!fs.existsSync(docxPath)) {
  console.error('找不到样本：' + docxPath + '，请先跑 make-office-fixtures.py');
  process.exit(1);
}

const buf = fs.readFileSync(docxPath);
const info = attachments.classify('sample.docx', '');
const text = attachments.extractText(buf, info);
const storedPath = path.join(dir, '_stored-sample.docx');
fs.writeFileSync(storedPath, buf);

const attachment = {
  id: 'att-1',
  name: 'sample.docx',
  ext: '.docx',
  kind: info.kind,
  mime: info.mime,
  size: buf.length,
  path: storedPath,
  url: 'file:///' + storedPath.replace(/\\/g, '/'),
  text,
  hasText: Boolean(text),
};

const messages = [
  { role: 'user', content: '帮我总结一下这个文档', attachments: [attachment] },
  { role: 'assistant', content: '好的', attachments: [] },
  { role: 'user', content: '重点看表格', attachments: [] },
];

// ---------- 拦截 fetch ----------
const captured = [];
const SSE = {
  openai: 'data: {"choices":[{"delta":{"content":"收到"}}]}\n\ndata: [DONE]\n\n',
  anthropic: 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"收到"}}\n\n',
  gemini: 'data: {"candidates":[{"content":{"parts":[{"text":"收到"}]}}]}\n\n',
};

const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const entry = { url: String(url), headers: opts.headers || {}, body: null, raw: opts.body };
  try {
    entry.body = JSON.parse(opts.body);
  } catch {
    entry.body = null;
  }
  captured.push(entry);
  const type = entry.url.includes('anthropic') ? 'anthropic'
    : entry.url.includes('generativelanguage') ? 'gemini' : 'openai';
  return new Response(SSE[type], { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

const conns = {
  openai: { id: 'c1', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test', model: 'deepseek-chat' },
  anthropic: { id: 'c2', name: 'Claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-test', model: 'claude-3-5-sonnet-latest' },
  gemini: { id: 'c3', name: 'Gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'sk-test', model: 'gemini-2.0-flash' },
};

async function run() {
  console.log('样本：' + docxPath + '（提取到 ' + text.length + ' 字符）\n');

  for (const type of ['openai', 'anthropic', 'gemini']) {
    await providers.streamChat({
      connection: conns[type],
      model: '',
      systemPrompt: '你是一个助手',
      temperature: 0.7,
      messages,
      signal: undefined,
      onDelta: () => {},
      onReasoning: () => {},
    });
  }

  const byType = {};
  captured.forEach((c) => {
    byType[c.url.includes('anthropic') ? 'anthropic'
      : c.url.includes('generativelanguage') ? 'gemini' : 'openai'] = c;
  });

  // ---------- OpenAI 兼容 ----------
  console.log('OpenAI 兼容协议（DeepSeek / OpenRouter / 中转站…）');
  const oa = byType.openai;
  check('请求发到了 /chat/completions', !!oa && /\/chat\/completions$/.test(oa.url), oa && oa.url);
  const oaUser = oa.body.messages.find((m) => m.role === 'user');
  const oaText = typeof oaUser.content === 'string'
    ? oaUser.content
    : oaUser.content.map((p) => p.text || '').join('');
  check('请求体里带着 docx 正文「季度报告 Quarter Report」', oaText.includes('季度报告 Quarter Report'));
  check('表格内容也在（「表头A」/「value 2」）', oaText.includes('表头A') && oaText.includes('value 2'));
  check('有「附件结束」分隔标记', oaText.includes('附件结束'));
  check('标注了这是 Word 文档', oaText.includes('Word 文档'));
  check('不是只发文件名（没有「仅提供文件名」占位）', !oaText.includes('仅提供文件名'));
  check('用户自己的提问也在', oaText.includes('帮我总结一下这个文档'));
  check('系统提示词在 messages 最前面', oa.body.messages[0].role === 'system');
  check('temperature 传下去了', oa.body.temperature === 0.7);
  console.log('\n  --- AI 实际收到的那段（节选）---');
  console.log(oaText.split('\n').slice(0, 14).map((l) => '  | ' + l).join('\n'));

  // ---------- Anthropic ----------
  console.log('\nAnthropic Claude 协议');
  const an = byType.anthropic;
  check('请求发到了 /v1/messages', !!an && /\/v1\/messages$/.test(an.url), an && an.url);
  check('system 是顶层字段', an.body.system === '你是一个助手');
  const anBlocks = an.body.messages[0].content;
  const anText = anBlocks.map((b) => b.text || '').join('');
  check('docx 正文在 content blocks 里', anText.includes('季度报告 Quarter Report'));
  check('表格内容也在', anText.includes('表头A') && anText.includes('value 2'));

  // ---------- Gemini ----------
  console.log('\nGoogle Gemini 协议');
  const gm = byType.gemini;
  check('请求发到了 streamGenerateContent', !!gm && /streamGenerateContent/.test(gm.url), gm && gm.url);
  check('system_instruction 独立传递', gm.body.system_instruction && gm.body.system_instruction.parts[0].text === '你是一个助手');
  const gmText = gm.body.contents[0].parts.map((p) => p.text || '').join('');
  check('docx 正文在 parts 里', gmText.includes('季度报告 Quarter Report'));
  check('表格内容也在', gmText.includes('表头A'));
  check('assistant 角色映射为 model', gm.body.contents[1].role === 'model');

  // ---------- 图片仍然走视觉通道，没被降级成文本 ----------
  console.log('\n回归：图片仍以视觉方式发送');
  const pngPath = path.join(dir, '_tiny.png');
  fs.writeFileSync(pngPath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'));
  const imgInfo = attachments.classify('tiny.png', '');
  const imgAtt = {
    id: 'att-2', name: 'tiny.png', ext: '.png', kind: imgInfo.kind, mime: imgInfo.mime,
    size: 70, path: pngPath, url: 'file:///' + pngPath.replace(/\\/g, '/'), text: '', hasText: false,
  };
  captured.length = 0;
  await providers.streamChat({
    connection: conns.openai, model: '', systemPrompt: '', temperature: 0.7,
    messages: [{ role: 'user', content: '这是什么', attachments: [imgAtt] }],
    onDelta: () => {}, onReasoning: () => {},
  });
  const imgMsg = captured[0].body.messages[0];
  const hasImagePart = Array.isArray(imgMsg.content) && imgMsg.content.some((p) => p.type === 'image_url');
  check('图片被包成 image_url（base64 data URL）', hasImagePart);
  check('图片确实带了 base64 数据', hasImagePart && /^data:image\/png;base64,/.test(imgMsg.content.find((p) => p.type === 'image_url').image_url.url));

  global.fetch = realFetch;
  try { fs.unlinkSync(storedPath); } catch { /* ignore */ }
  try { fs.unlinkSync(pngPath); } catch { /* ignore */ }

  console.log('\n================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

run().catch((err) => {
  global.fetch = realFetch;
  console.error('测试自身出错：', err);
  process.exit(1);
});
