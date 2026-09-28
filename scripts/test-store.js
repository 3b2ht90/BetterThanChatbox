'use strict';

// store 的「消息版本 / 对话分支」单元测试（不依赖 Electron）
// 用法： node scripts/test-store.js

const fs = require('fs');
const path = require('path');
const { Store } = require('../app/lib/store');

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

const DIR = path.join(__dirname, '..', '.store-test');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

console.log('store 消息版本 / 对话分支');

// ---------- 1. 老数据迁移 ----------
const legacy = {
  version: 1,
  settings: {},
  connections: [],
  activeConnectionId: null,
  conversations: [
    {
      id: 'c1',
      title: '旧对话',
      messages: [
        { id: 'm1', role: 'user', content: '你好' },
        { id: 'm2', role: 'assistant', content: '你好呀', reasoning: '想一下', error: null },
      ],
    },
  ],
};
fs.writeFileSync(path.join(DIR, 'data.json'), JSON.stringify(legacy), 'utf8');

const store = new Store(DIR);
const conv = store.getConversation('c1');
eq('迁移：两条消息各补成 1 个版本', conv.messages.map((m) => m.variants.length), [1, 1]);
eq('迁移：当前版本号都是 0', conv.messages.map((m) => m.activeVariant), [0, 0]);
eq('迁移：顶层内容不变', conv.messages.map((m) => m.content), ['你好', '你好呀']);
eq('迁移：推理内容进了版本里', conv.messages[1].variants[0].reasoning, '想一下');
eq('迁移：版本里的内容与顶层一致', conv.messages[1].variants[0].content, '你好呀');

// ---------- 2. 新建消息自带单版本 ----------
const m3 = store.appendMessage('c1', { role: 'assistant', content: '第一版回答' });
eq('新建：版本数 1', m3.variants.length, 1);
eq('新建：当前版本 0', m3.activeVariant, 0);

// ---------- 3. updateMessage 写进当前版本 ----------
store.updateMessage('c1', m3.id, { content: '改过的第一版', reasoning: 'r1' });
eq('更新：顶层被改写', m3.content, '改过的第一版');
eq('更新：当前版本同步改写', m3.variants[0].content, '改过的第一版');
eq('更新：推理同步', m3.variants[0].reasoning, 'r1');

// ---------- 4. addVariant：追加新版本并选中 ----------
const added = store.addVariant('c1', m3.id, { content: '第二版回答' });
eq('追加：版本数 2', m3.variants.length, 2);
eq('追加：当前版本指向新的那个', m3.activeVariant, 1);
eq('追加：顶层是第二版', m3.content, '第二版回答');
eq('追加：旧版本内容还在', m3.variants[0].content, '改过的第一版');
eq('追加：返回的版本号', added.variantIndex, 1);

// ---------- 5. 切换版本 ----------
const sw = store.setActiveVariant('c1', m3.id, 0);
eq('切换：当前版本回 0', m3.activeVariant, 0);
eq('切换：顶层回到第一版', m3.content, '改过的第一版');
eq('切换：第二版没被丢掉', m3.variants[1].content, '第二版回答');
eq('切换：返回被改动的消息数', sw.changed.length, 1);
ok('切换：越界返回 null', store.setActiveVariant('c1', m3.id, 5) === null);
ok('切换：负数返回 null', store.setActiveVariant('c1', m3.id, -1) === null);
ok('切换：消息不存在返回 null', store.setActiveVariant('c1', 'not-exist', 0) === null);

// ---------- 6. 提问 / 回答成对对齐（分支） ----------
const conv2 = store.createConversation({ title: '分支' });
const q = store.appendMessage(conv2.id, { role: 'user', content: '问题一' });
const a = store.appendMessage(conv2.id, { role: 'assistant', content: '回答一' });
store.addVariant(conv2.id, q.id, { content: '问题二' });
store.addVariant(conv2.id, a.id, { content: '回答二' });
eq('成对：提问两版', q.variants.length, 2);
eq('成对：回答两版', a.variants.length, 2);

store.setActiveVariant(conv2.id, q.id, 0);
eq('成对：切提问到第 1 版，回答跟着回第 1 版', [q.content, a.content], ['问题一', '回答一']);
const sw2 = store.setActiveVariant(conv2.id, a.id, 1);
eq('成对：从回答侧切到第 2 版，提问也跟着', [q.content, a.content], ['问题二', '回答二']);
eq('成对：一次改动两条消息', sw2.changed.map((m) => m.role), ['assistant', 'user']);

// 版本数不一致时不强行对齐
const conv3 = store.createConversation({ title: '不对称' });
const q3 = store.appendMessage(conv3.id, { role: 'user', content: 'q1' });
const a3 = store.appendMessage(conv3.id, { role: 'assistant', content: 'a1' });
store.addVariant(conv3.id, q3.id, { content: 'q2' });
store.addVariant(conv3.id, q3.id, { content: 'q3' }); // 提问 3 版、回答仍 1 版
store.setActiveVariant(conv3.id, q3.id, 2);
eq('不对称：提问切到第 3 版', q3.content, 'q3');
eq('不对称：回答没有第 3 版，保持原样', [a3.variants.length, a3.content], [1, 'a1']);

// ---------- 7. 改写第一条提问 → 标题跟着更新 ----------
const conv4 = store.createConversation({ title: '新对话' });
const q4 = store.appendMessage(conv4.id, { role: 'user', content: '北京天气怎么样' });
eq('标题：建对话时用第一条提问', conv4.title, '北京天气怎么样');
const res4 = store.addVariant(conv4.id, q4.id, { content: '上海天气怎么样' });
eq('标题：改写第一条提问后跟着变', conv4.title, '上海天气怎么样');
eq('标题：返回里带上了新标题', res4.title, '上海天气怎么样');
store.appendMessage(conv4.id, { role: 'assistant', content: 'a' });
store.addVariant(conv4.id, q4.id, { content: '广州天气怎么样' });
eq('标题：第二次改写也跟上', conv4.title, '广州天气怎么样');

// ---------- 8. 落盘 + 重新读回 ----------
store.saveNow();
const store2 = new Store(DIR);
const conv2b = store2.getConversation('c1');
const m3b = conv2b.messages.find((m) => m.id === m3.id);
eq('落盘：版本数保留', m3b.variants.length, 2);
eq('落盘：当前版本保留', [m3b.activeVariant, m3b.content], [0, '改过的第一版']);
eq('落盘：另一版本内容保留', m3b.variants[1].content, '第二版回答');

// ---------- 9. 删除消息不受影响 ----------
ok('删除：删除存在的消息', store.deleteMessage('c1', m3.id) === true);
ok('删除：删掉后查不到', store.getConversation('c1').messages.find((m) => m.id === m3.id) === undefined);

store.saveNow(); // 先落盘，免得删掉临时目录后延迟保存的定时器再报错
fs.rmSync(DIR, { recursive: true, force: true });

console.log('\n===== store ' + pass + ' 通过 / ' + fail + ' 失败 =====');
if (fail) {
  console.log('失败项：\n  ' + failures.join('\n  '));
  process.exit(1);
}
