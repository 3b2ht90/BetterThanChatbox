'use strict';

// 模型下拉列表内容来源的单元测试
// 用法： node scripts/test-model-options.js

const assert = require('assert');
const mo = require('../app/lib/modelOptions');

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

const state = {
  connections: [
    { id: 'c1', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'], modelsFetchedAt: '2026-09-28T02:00:00.000Z' },
    { id: 'c2', name: '本地', type: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: '' },
  ],
  conversations: [
    { id: 'v1', connectionId: 'c1', model: 'deepseek-reasoner' },
    { id: 'v2', connectionId: 'c1', model: 'deepseek-chat' },
    { id: 'v3', connectionId: 'c1', model: 'gpt-4o' },
    { id: 'v4', connectionId: 'c2', model: '别的接口的模型' },
    { id: 'v5', connectionId: 'c1', model: '' },
  ],
};

console.log('常用模型预设（按 Base URL 猜）');
check('DeepSeek 站点给 deepseek 系列', () => {
  const p = mo.presetsFor(state.connections[0]);
  assert(p.includes('deepseek-chat') && p.includes('deepseek-reasoner'), JSON.stringify(p));
});
check('OpenRouter 给带前缀的模型名', () => {
  const p = mo.presetsFor({ type: 'openai', baseUrl: 'https://openrouter.ai/api/v1' });
  assert(p.some((m) => m.startsWith('openai/')), JSON.stringify(p));
});
check('本地地址给 ollama 风格模型名', () => {
  const p = mo.presetsFor({ type: 'openai', baseUrl: 'http://127.0.0.1:11434/v1' });
  assert(p.some((m) => m.includes(':')), JSON.stringify(p));
});
check('Claude 官方给 claude 系列', () => {
  const p = mo.presetsFor({ type: 'anthropic', baseUrl: '' });
  assert(p.every((m) => m.startsWith('claude')), JSON.stringify(p));
});
check('Gemini 官方给 gemini 系列', () => {
  const p = mo.presetsFor({ type: 'gemini', baseUrl: '' });
  assert(p.every((m) => m.startsWith('gemini')), JSON.stringify(p));
});
check('认不出的地址给通用 OpenAI 模型兜底', () => {
  const p = mo.presetsFor({ type: 'openai', baseUrl: 'https://some-proxy.example.com/v1' });
  assert(p.includes('gpt-4o-mini'), JSON.stringify(p));
});
check('没有接口时也不崩', () => {
  assert(Array.isArray(mo.presetsFor(null)));
});

console.log('\n分组生成');
const sug = mo.suggestModels(state, state.connections[0], 'deepseek-reasoner');
check('返回三要素', () => {
  assert(Array.isArray(sug.groups));
  assert.strictEqual(sug.fetchedAt, '2026-09-28T02:00:00.000Z');
  assert.strictEqual(sug.hasCache, true);
});
check('分组按可信度从高到低排列', () => {
  const labels = sug.groups.map((g) => g.label);
  const order = ['当前使用', '来自接口', '本机用过的', '常用模型'];
  // 允许某些组因为「没有新内容可加」而不出现，但出现的一定要守序
  let last = -1;
  for (const l of labels) {
    const idx = order.indexOf(l);
    assert(idx > last, '分组顺序错了：' + JSON.stringify(labels));
    last = idx;
  }
  assert.deepStrictEqual(labels, ['当前使用', '来自接口', '本机用过的'], JSON.stringify(labels));
});
check('预设只在能补充新模型时才出现（这里被前两组占满了，所以不出现）', () => {
  const labels = sug.groups.map((g) => g.label);
  assert(!labels.includes('常用模型'), 'DeepSeek 预设已被去重占满，不该再有「常用模型」组');
});
check('预设能补充内容时确实排最后', () => {
  const proxy = { id: 'c9', name: '中转', type: 'openai', baseUrl: 'https://some-proxy.example.com/v1', model: '', models: ['my-only-model', 'second-model'] };
  const s = mo.suggestModels({ connections: [proxy], conversations: [] }, proxy, 'my-only-model');
  const labels = s.groups.map((g) => g.label);
  assert.deepStrictEqual(labels, ['当前使用', '来自接口', '常用模型'], JSON.stringify(labels));
  assert.deepStrictEqual(s.groups[1].models, ['second-model']);
  assert(s.groups[2].models.includes('gpt-4o-mini'));
});
check('当前模型排在最前面且只出现一次', () => {
  const all = sug.groups.flatMap((g) => g.models);
  assert.strictEqual(all[0], 'deepseek-reasoner');
  assert.strictEqual(all.filter((m) => m === 'deepseek-reasoner').length, 1, JSON.stringify(all));
});
check('「来自接口」用的是缓存列表，且不含当前模型（已去重）', () => {
  const g = sug.groups.find((x) => x.label === '来自接口');
  assert.deepStrictEqual(g.models, ['deepseek-chat', 'deepseek-coder']);
});
check('「本机用过的」收进其它对话用过的模型', () => {
  const g = sug.groups.find((x) => x.label === '本机用过的');
  assert(g.models.includes('gpt-4o'), JSON.stringify(g.models));
});
check('不串台：别的接口的对话不会混进来', () => {
  const all = sug.groups.flatMap((g) => g.models);
  assert(!all.includes('别的接口的模型'), JSON.stringify(all));
});
check('全局不重复', () => {
  const all = sug.groups.flatMap((g) => g.models);
  assert.strictEqual(new Set(all).size, all.length, JSON.stringify(all));
});
check('没有缓存的接口 hasCache=false，但仍有常用模型可点', () => {
  const s2 = mo.suggestModels(state, state.connections[1], '');
  assert.strictEqual(s2.hasCache, false);
  assert.strictEqual(s2.fetchedAt, null);
  const all = s2.groups.flatMap((g) => g.models);
  assert(all.length > 0, '常用模型兜底没了');
});
check('当前模型为空时没有「当前使用」分组', () => {
  const s2 = mo.suggestModels(state, state.connections[1], '');
  assert(!s2.groups.some((g) => g.label === '当前使用'));
});
check('接口/状态为空时不崩', () => {
  const s3 = mo.suggestModels({}, null, '');
  assert(Array.isArray(s3.groups));
});

console.log('\n拉取结果规范化');
check('去掉 models/ 前缀', () => {
  assert.deepStrictEqual(mo.normalizeFetched(['models/gemini-2.0-flash']), ['gemini-2.0-flash']);
});
check('去重', () => {
  assert.deepStrictEqual(mo.normalizeFetched(['a', 'a', 'b']), ['a', 'b']);
});
check('丢掉空值与非字符串', () => {
  assert.deepStrictEqual(mo.normalizeFetched(['a', '', null, undefined, '  ']), ['a']);
});
check('排序稳定', () => {
  assert.deepStrictEqual(mo.normalizeFetched(['c', 'a', 'b']), ['a', 'b', 'c']);
});
check('非数组输入不崩', () => {
  assert.deepStrictEqual(mo.normalizeFetched(null), []);
});

console.log('\n================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
