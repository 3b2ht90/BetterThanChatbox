'use strict';

// 「完整思考过程」的单元测试：三种协议各自怎么拿到思考、拿不到时怎么降级。
// 用法： node scripts/test-reasoning.js

const assert = require('assert');
const providers = require('../app/lib/providers');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail++;
    console.log('  ✗ ' + name + '  → ' + err.message);
  }
}

const realFetch = global.fetch;
let captured = [];

/** 用一串 SSE 事件模拟接口；body 里带 reasoning 的按 delta 发 */
function stubSSE(events, opts = {}) {
  captured = [];
  global.fetch = async (url, init = {}) => {
    captured.push({ url: String(url), body: JSON.parse(init.body) });
    if (opts.failOnce && captured.length === 1) {
      return new Response(JSON.stringify({ error: { message: opts.failOnce } }),
        { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const text = events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('') + 'data: [DONE]\n\n';
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

function collect() {
  const out = { text: '', reasoning: '', chunks: [] };
  return {
    out,
    onDelta: (t) => { out.text += t; },
    onReasoning: (t) => { out.reasoning += t; out.chunks.push(t); },
  };
}

const conns = {
  openai: { id: 'a', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-reasoner' },
  openrouter: { id: 'b', name: 'OR', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', model: 'x/y' },
  anthropic: { id: 'c', name: 'Claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-3-7-sonnet-latest' },
  gemini: { id: 'd', name: 'Gemini', type: 'gemini', baseUrl: '', apiKey: 'k', model: 'gemini-2.5-flash' },
};
const msgs = [{ role: 'user', content: '你好', attachments: [] }];

async function run(conn, events, opts = {}) {
  stubSSE(events, opts);
  const c = collect();
  const res = await providers.streamChat({
    connection: conn, model: '', systemPrompt: '', temperature: 0.7, messages: msgs,
    thinking: { enabled: opts.thinking !== false },
    onDelta: c.onDelta, onReasoning: c.onReasoning,
  });
  return { res, ...c };
}

(async () => {
  console.log('OpenAI 兼容：字段名不一样都要认');

  {
    const { res, out } = await run(conns.openai, [
      { choices: [{ delta: { reasoning_content: '第一步：' } }] },
      { choices: [{ delta: { reasoning_content: '看题目。' } }] },
      { choices: [{ delta: { content: '答案是 42。' } }] },
    ]);
    check('DeepSeek 的 reasoning_content 被完整收下', () => {
      assert.strictEqual(res.reasoning, '第一步：看题目。');
      assert.strictEqual(res.text, '答案是 42。');
      assert.deepStrictEqual(out.chunks, ['第一步：', '看题目。'], '片数不对');
    });
  }

  {
    const { res, out } = await run(conns.openrouter, [
      { choices: [{ delta: { reasoning: '用 reasoning 字段的中转站' } }] },
      { choices: [{ delta: { content: 'ok' } }] },
    ]);
    check('OpenRouter 的 reasoning 字段也能收到', () => {
      assert.strictEqual(res.reasoning, '用 reasoning 字段的中转站');
      assert.deepStrictEqual(out.chunks, ['用 reasoning 字段的中转站']);
    });
  }

  {
    const { res } = await run(conns.openai, [
      { choices: [{ delta: { thinking: '有些中转站叫 thinking' } }] },
      { choices: [{ delta: { content: 'ok' } }] },
    ]);
    check('thinking 字段也能收到', () => assert.strictEqual(res.reasoning, '有些中转站叫 thinking'));
  }

  {
    const { res } = await run(conns.openai, [
      { choices: [{ delta: { content: '没有思考的回答' } }] },
    ]);
    check('没有思考时 reasoning 为空、且不影响正文', () => {
      assert.strictEqual(res.reasoning, '');
      assert.strictEqual(res.text, '没有思考的回答');
    });
  }

  {
    await run(conns.openai, [{ choices: [{ delta: { content: 'x' } }] }]);
    check('普通 OpenAI 兼容接口不会乱加参数', () => {
      const b = captured[0].body;
      assert.strictEqual(b.reasoning, undefined, JSON.stringify(b));
      assert.strictEqual(b.temperature, 0.7);
    });
  }
  {
    await run(conns.openrouter, [{ choices: [{ delta: { content: 'x' } }] }]);
    check('OpenRouter 会显式打开 reasoning', () => {
      assert.deepStrictEqual(captured[0].body.reasoning, { enabled: true });
    });
  }

  console.log('\nAnthropic：必须主动请求才有思考');
  {
    const { res } = await run(conns.anthropic, [
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '我先想一下。' } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '再想一下。' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '结论是 A。' } },
    ]);
    check('thinking_delta 被完整收下', () => {
      assert.strictEqual(res.reasoning, '我先想一下。再想一下。');
      assert.strictEqual(res.text, '结论是 A。');
    });
    check('请求里带了 thinking 参数', () => {
      const b = captured[0].body;
      assert.strictEqual(b.thinking.type, 'enabled');
      assert(b.thinking.budget_tokens > 0);
      assert(b.thinking.budget_tokens < b.max_tokens, 'budget 必须小于 max_tokens');
    });
    check('开思考时不再传 temperature（接口不允许）', () => {
      assert.strictEqual(captured[0].body.temperature, undefined);
    });
  }
  {
    const { } = await run(conns.anthropic, [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }], { thinking: false });
    check('关掉思考时不带 thinking 参数、temperature 照传', () => {
      const b = captured[0].body;
      assert.strictEqual(b.thinking, undefined);
      assert.strictEqual(b.temperature, 0.7);
    });
  }
  {
    // 老模型不支持 thinking：接口报 400，应自动去掉参数重试
    const { res, out } = await run(conns.anthropic, [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '没有思考的回答' } },
    ], { failOnce: 'thinking is not supported for this model' });
    check('模型不支持思考时自动降级重试（对话不会挂掉）', () => {
      assert.strictEqual(res.text, '没有思考的回答');
      assert.strictEqual(res.thinkingSkipped, true, '应标记已降级');
      assert.strictEqual(captured.length, 2, '应该重试了一次');
      assert.strictEqual(captured[0].body.thinking.type, 'enabled');
      assert.strictEqual(captured[1].body.thinking, undefined, '重试时要去掉 thinking');
      assert.strictEqual(out.reasoning, '');
    });
  }
  {
    // 别的报错不该触发重试
    let threw = null;
    try {
      await run(conns.anthropic, [], { failOnce: 'invalid api key' });
    } catch (err) {
      threw = err;
    }
    check('与思考无关的错误不做重试、原样抛出', () => {
      assert(threw && /invalid api key/.test(threw.message), threw && threw.message);
      assert.strictEqual(captured.length, 1, '不该重试');
    });
  }

  console.log('\nGemini：思考片段不能混进回答');
  {
    const { res } = await run(conns.gemini, [
      { candidates: [{ content: { parts: [{ text: '我在想……', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: '（继续想）', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: '最终回答。' }] } }] },
    ]);
    check('thought:true 的片段进思考、不进回答', () => {
      assert.strictEqual(res.reasoning, '我在想……（继续想）');
      assert.strictEqual(res.text, '最终回答。');
      assert(!res.text.includes('我在想'), '思考被混进正文了');
    });
    check('请求里带了 includeThoughts', () => {
      const gen = captured[0].body.generationConfig;
      assert.deepStrictEqual(gen.thinkingConfig, { includeThoughts: true });
      assert.strictEqual(gen.temperature, 0.7, 'temperature 仍要保留');
    });
  }
  {
    await run(conns.gemini, [{ candidates: [{ content: { parts: [{ text: 'x' }] } }] }], { thinking: false });
    check('关掉思考时不请求 includeThoughts', () => {
      const gen = captured[0].body.generationConfig || {};
      assert.strictEqual(gen.thinkingConfig, undefined);
    });
  }

  console.log('\n长思考不会被截断');
  {
    const pieces = [];
    for (let i = 0; i < 500; i++) pieces.push({ choices: [{ delta: { reasoning_content: '片段' + i + '，' } }] });
    pieces.push({ choices: [{ delta: { content: '完' } }] });
    const { res, out } = await run(conns.openai, pieces);
    check('500 个思考片段一个不落', () => {
      assert.strictEqual(out.chunks.length, 500, String(out.chunks.length));
      assert.strictEqual(res.reasoning.length, pieces.slice(0, 500).reduce((n, p) => n + p.choices[0].delta.reasoning_content.length, 0));
      assert(res.reasoning.startsWith('片段0，') && res.reasoning.endsWith('片段499，'));
    });
    check('思考与正文互不污染', () => {
      assert.strictEqual(res.text, '完');
      assert(!res.reasoning.includes('完'));
    });
  }

  global.fetch = realFetch;
  console.log('\n================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  global.fetch = realFetch;
  console.error('测试自身出错：', err);
  process.exit(1);
});
