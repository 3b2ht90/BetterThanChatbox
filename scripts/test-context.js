'use strict';
const assert = require('assert');
const context = require('../app/lib/context');
let pass=0, fail=0;
const check=(n,f)=>{try{f();pass++;console.log('  ✓ '+n)}catch(e){fail++;console.log('  ✗ '+n+'  → '+e.message)}};

console.log('token 估算');
check('纯英文按 4 字符 ≈ 1 token', () => {
  const t = context.estimateTokens('a'.repeat(400));
  assert(t >= 90 && t <= 110, String(t));
});
check('中文按 1 字 ≈ 1 token', () => {
  const t = context.estimateTokens('这是一段中文测试文本');
  assert(t >= 9 && t <= 12, String(t));
});
check('中英混合', () => {
  const t = context.estimateTokens('你好 hello 世界');
  assert(t >= 4 && t <= 8, String(t));
});
check('空串 / null 是 0', () => {
  assert.strictEqual(context.estimateTokens(''), 0);
  assert.strictEqual(context.estimateTokens(null), 0);
});
check('代码里的符号也算', () => {
  assert(context.estimateTokens('const a = {b: 1};') > 3);
});

console.log('\n上下文窗口');
check('常见模型都能认出来', () => {
  assert.strictEqual(context.contextLimit('deepseek-chat'), 65536);
  assert.strictEqual(context.contextLimit('claude-3-7-sonnet-latest'), 200000);
  assert.strictEqual(context.contextLimit('gemini-2.5-flash'), 1048576);
  assert.strictEqual(context.contextLimit('gpt-4o'), 128000);
  assert.strictEqual(context.contextLimit('o3-mini'), 200000);
});
check('认不出来的给默认值', () => {
  assert.strictEqual(context.contextLimit('some-unknown-model'), context.DEFAULT_LIMIT);
});
check('手填的值优先', () => {
  assert.strictEqual(context.contextLimit('deepseek-chat', 32000), 32000);
  assert.strictEqual(context.contextLimit('deepseek-chat', 0), 65536);
});
check('gpt-5 不会被 gpt-4 规则误伤', () => {
  assert.strictEqual(context.contextLimit('gpt-5-mini'), 200000);
});

console.log('\n用量计算');
check('空对话就是系统提示词那点量', () => {
  const u = context.contextUsage({ systemPrompt: '你是助手', messages: [], model: 'deepseek-chat' });
  assert(u.tokens > 0 && u.tokens < 20, String(u.tokens));
  assert.strictEqual(u.limit, 65536);
});
check('消息正文计入', () => {
  const u = context.contextUsage({ messages: [{ role:'user', content:'x'.repeat(400) }], model:'gpt-4o' });
  assert(u.tokens >= 100 && u.tokens <= 110, String(u.tokens));
});
check('思考过程也占上下文', () => {
  const a = context.contextUsage({ messages: [{ role:'assistant', content:'短', reasoning:'' }], model:'gpt-4o' });
  const b = context.contextUsage({ messages: [{ role:'assistant', content:'短', reasoning:'x'.repeat(400) }], model:'gpt-4o' });
  assert(b.tokens > a.tokens + 90);
});
check('附件正文计入，文件夹按大小估，图片按固定开销', () => {
  const u = context.contextUsage({ messages: [{ role:'user', content:'', attachments:[
    { kind:'text', text:'x'.repeat(400) },
    { kind:'folder', totalBytes: 8000 },
    { kind:'image' },
  ]}], model:'gpt-4o' });
  assert(u.tokens >= 100 + 1000 + 800 - 50, String(u.tokens));
});
check('百分比算得对', () => {
  const u = context.contextUsage({ messages: [{ role:'user', content:'x'.repeat(4000) }], model:'gpt-4', limitOverride: 1000 });
  assert.strictEqual(u.limit, 1000);
  assert.strictEqual(u.percent, 100);   // 封顶 100
});
check('用量等级', () => {
  assert.strictEqual(context.usageLevel(10), 'low');
  assert.strictEqual(context.usageLevel(60), 'mid');
  assert.strictEqual(context.usageLevel(80), 'high');
});

console.log('\n压缩：挑哪些消息');
check('保留最近的，其余可压缩', () => {
  const msgs = Array.from({length:10},(_,i)=>({id:'m'+i, role:i%2?'assistant':'user', content:'c'+i}));
  const { picked, kept } = context.pickCompressible(msgs, 4);
  assert.strictEqual(picked.length, 6);
  assert.strictEqual(kept.length, 4);
  assert.strictEqual(kept[0].id, 'm6');
});
check('已经压缩过的不会被重复挑', () => {
  const msgs = [
    {id:'a', content:'1', compressed:true},
    {id:'b', content:'2'},
    {id:'c', content:'3'},
    {id:'d', content:'4'},
    {id:'e', content:'5'},
    {id:'f', content:'6'},
  ];
  const { picked } = context.pickCompressible(msgs, 2);
  assert.deepStrictEqual(picked.map(m=>m.id), ['b','c','d']);
});
check('摘要消息本身不会再被压（避免套娃）', () => {
  const msgs = [{id:'s', isSummary:true, content:'摘要'}, {id:'b', content:'2'}, {id:'c', content:'3'}, {id:'d', content:'4'}];
  const { picked } = context.pickCompressible(msgs, 1);
  assert(!picked.some(m=>m.id==='s'));
});
check('出错的消息不参与', () => {
  const msgs = [{id:'a', content:'1', error:'失败'}, {id:'b', content:'2'}, {id:'c', content:'3'}, {id:'d', content:'4'}];
  const { picked } = context.pickCompressible(msgs, 1);
  assert(!picked.some(m=>m.id==='a'));
});

console.log('\n压缩：拼给模型的记录');
check('带角色标签，空消息跳过', () => {
  const t = context.transcriptOf([
    {role:'user', content:'你好'},
    {role:'assistant', content:'你好呀'},
    {role:'assistant', content:'   '},
  ]);
  assert(t.includes('【用户】你好'));
  assert(t.includes('【AI】你好呀'));
  assert.strictEqual(t.split('【').length - 1, 2);
});
check('摘要消息带上说明与条数', () => {
  const s = context.summaryMessageText('要点一\n要点二', 8);
  assert(s.includes('上下文摘要'));
  assert(s.includes('8 条'));
  assert(s.includes('要点一'));
});

console.log('\n================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail?1:0);
