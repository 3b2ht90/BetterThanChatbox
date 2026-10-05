'use strict';

// 数据目录选择与迁移的单元测试。
// 这里钉的是用户最不能接受的问题：「一更新，对话和配置就没了」。
// 用法： node scripts/test-datadir.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const datadir = require('../app/lib/datadir');

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-datadir-'));

function mkState(dir, { connections = 0, conversations = 0, messages = 0 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const conns = [];
  for (let i = 0; i < connections; i++) conns.push({ id: 'c' + i, name: '接口' + i, type: 'openai', apiKey: 'k' + i });
  const convs = [];
  for (let i = 0; i < conversations; i++) {
    const msgs = [];
    for (let j = 0; j < messages; j++) msgs.push({ id: 'm' + i + j, role: j % 2 ? 'assistant' : 'user', content: '内容' + j });
    convs.push({ id: 'v' + i, title: '对话' + i, messages: msgs });
  }
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({
    version: 1, settings: {}, connections: conns, activeConnectionId: conns[0] ? conns[0].id : null, conversations: convs,
  }), 'utf8');
  return dir;
}

const userData = mkState(path.join(tmp, 'appdata', 'BetterThanChatbox'), { connections: 2, conversations: 1, messages: 2 });
const shell = mkState(path.join(tmp, 'portable', 'data'), { connections: 0, conversations: 1, messages: 0 });
const empty = path.join(tmp, 'empty', 'data');
fs.mkdirSync(empty, { recursive: true });

console.log('打分：分清「有数据」和「空壳」');
check('有接口有消息 → 分数 > 0', () => {
  assert(datadir.dataScore(userData) > 0);
  assert.strictEqual(datadir.dataScore(userData), 6); // 2 接口×2 + 2 消息
});
check('只有空对话（没接口没消息）→ 0，不算有数据', () => {
  assert.strictEqual(datadir.dataScore(shell), 0);
});
check('没有文件 → -1', () => {
  assert.strictEqual(datadir.dataScore(empty), -1);
});
check('文件坏了 → -1（不能拿来当数据用）', () => {
  const bad = path.join(tmp, 'bad');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'data.json'), '{坏掉的', 'utf8');
  assert.strictEqual(datadir.dataScore(bad), -1);
});
check('带 BOM 的文件也能算出来（PowerShell 写出来的就是这种）', () => {
  const bom = path.join(tmp, 'bom');
  fs.mkdirSync(bom, { recursive: true });
  fs.writeFileSync(path.join(bom, 'data.json'),
    '\uFEFF' + JSON.stringify({ connections: [{ id: 'a' }], conversations: [] }), 'utf8');
  assert.strictEqual(datadir.dataScore(bom), 2);
});

console.log('\n选目录：优先用「有数据的」，而不是「先可写的」');
check('首选目录有数据且可写 → 就用它', () => {
  const r = datadir.pickDataDir([userData, shell], () => true);
  assert.strictEqual(r.dir, userData);
  assert.strictEqual(r.warning, null);
});
check('首选目录只有空壳、别处有数据 → 用有数据的那个', () => {
  // 这正是「打开软件发现一片空白」的场景：空壳目录可写、真数据在别处
  const r = datadir.pickDataDir([shell, userData], () => true);
  assert.strictEqual(r.dir, userData);
});
check('两个都有数据 → 用数据更多的那个', () => {
  const small = mkState(path.join(tmp, 'small'), { connections: 1, conversations: 0, messages: 0 });
  const r = datadir.pickDataDir([small, userData], () => true);
  assert.strictEqual(r.dir, userData);
});
check('都没数据 → 用第一个可写的（首次运行）', () => {
  const r = datadir.pickDataDir([shell, empty], (d) => d === empty);
  assert.strictEqual(r.dir, empty);
});

console.log('\n关键场景：有数据的目录写不进去 → 必须搬，不能开空目录');
{
  const src = mkState(path.join(tmp, 'locked', 'BetterThanChatbox'), { connections: 2, conversations: 1, messages: 2 });
  const dst = path.join(tmp, 'writable', 'data');
  const r = datadir.pickDataDir([src, dst], (d) => d !== src);
  check('选中了可写目录（不会去用写不进去的那个）', () => assert.strictEqual(r.dir, dst, r.dir));
  check('并且把数据搬了过去', () => {
    assert.strictEqual(r.movedFrom, src);
    assert(fs.existsSync(path.join(dst, 'data.json')), '目标目录里没有 data.json');
    const j = JSON.parse(fs.readFileSync(path.join(dst, 'data.json'), 'utf8').replace(/^\uFEFF/, ''));
    assert.strictEqual(j.connections.length, 2);
    assert.strictEqual(j.conversations.length, 1);
    assert.strictEqual(j.conversations[0].messages.length, 2);
  });
  check('源目录的东西一个都没删', () => {
    assert(fs.existsSync(path.join(src, 'data.json')));
    const j = JSON.parse(fs.readFileSync(path.join(src, 'data.json'), 'utf8'));
    assert.strictEqual(j.connections.length, 2);
  });
  check('给了明确的提示文案（告诉用户数据搬到哪了）', () => {
    assert(r.warning && r.warning.includes(src) && r.warning.includes(dst), r.warning);
    assert(/没有删/.test(r.warning), '要说清原目录没删，否则用户更慌');
  });
  check('搬家不会覆盖目标目录里的既有文件（先另存一份）', () => {
    // 目标目录里已经有个空壳 data.json（分数 0，不会被选为"有数据"），
    // 搬家时要把它先另存成 .replaced-<时间>，而不是直接盖掉
    const src2 = mkState(path.join(tmp, 'locked2', 'x'), { connections: 1, conversations: 1, messages: 1 });
    const dst2 = mkState(path.join(tmp, 'writable2', 'data'), { connections: 0, conversations: 1, messages: 0 });
    const r2 = datadir.pickDataDir([src2, dst2], (d) => d !== src2);
    assert.strictEqual(r2.dir, dst2, '应选可写的那个');
    const dir = path.dirname(path.join(dst2, 'data.json'));
    const replaced = fs.readdirSync(dir).filter((f) => f.includes('.replaced-'));
    assert(replaced.length >= 1, '目标目录里原来的数据没有被另存：' + fs.readdirSync(dir).join(','));
    // 而且搬完之后目标目录里是源目录的数据
    const j = JSON.parse(fs.readFileSync(path.join(dst2, 'data.json'), 'utf8'));
    assert.strictEqual(j.connections.length, 1, '搬过来的数据不对');
  });
}

console.log('\n附件目录也一起搬');
{
  const src = mkState(path.join(tmp, 'locked3', 'data'), { connections: 1, conversations: 1, messages: 1 });
  fs.mkdirSync(path.join(src, 'files'), { recursive: true });
  fs.writeFileSync(path.join(src, 'files', 'a.png'), 'PNGDATA', 'utf8');
  const dst = path.join(tmp, 'writable3', 'data');
  const r = datadir.pickDataDir([src, dst], (d) => d !== src);
  check('files\\ 里的附件也复制过去了', () => {
    assert(fs.existsSync(path.join(dst, 'files', 'a.png')), fs.readdirSync(dst).join(','));
  });
  check('返回的搬运清单里能看出搬了什么', () => {
    assert(r.copied.includes('data.json'), JSON.stringify(r.copied));
    assert(r.copied.some((c) => c.startsWith('files/')), JSON.stringify(r.copied));
  });
}

console.log('\n一个可写的都没有时不能崩');
{
  const src = mkState(path.join(tmp, 'alllocked', 'data'), { connections: 1, conversations: 1, messages: 1 });
  const r = datadir.pickDataDir([src, path.join(tmp, 'also-locked')], () => false);
  check('退回有数据的那个目录（只读也要能看）', () => assert.strictEqual(r.dir, src));
  check('不会抛异常', () => assert(r.warning === null));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
