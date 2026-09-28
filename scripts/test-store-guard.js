'use strict';

// 数据文件「读不出来」时的自保行为测试。
//
// 背景：以前的 store._read() 是 try { JSON.parse } catch { return defaultState() }，
// 于是只要 data.json 带个 UTF-8 BOM（记事本 / PowerShell 另存常见）或者稍微损坏，
// 用户填好的接口就会在「读成空 → 下一次保存覆盖」两步里彻底消失。
// 这个脚本就是盯着这条路径，确保它不再发生。
//
// 用法： node scripts/test-store-guard.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../app/lib/store');

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
const assert = require('assert');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-guard-'));

function freshDir(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const GOOD = JSON.stringify({
  version: 1,
  settings: { theme: 'dark' },
  connections: [{ id: 'k1', name: '我的 DeepSeek', apiKey: 'sk-real-key', model: 'deepseek-chat' }],
  activeConnectionId: 'k1',
  conversations: [{ id: 'c1', title: '重要对话', messages: [] }],
});

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

console.log('正常情况');
check('没有文件时用默认状态，且不报警告', () => {
  const s = new Store(freshDir('nofile'));
  assert.strictEqual(s.state.connections.length, 0);
  assert.strictEqual(s.readWarning, null);
});
check('正常 UTF-8 文件能读回接口和对话', () => {
  const dir = freshDir('normal');
  fs.writeFileSync(path.join(dir, 'data.json'), GOOD, 'utf8');
  const s = new Store(dir);
  assert.strictEqual(s.state.connections.length, 1);
  assert.strictEqual(s.state.connections[0].apiKey, 'sk-real-key');
  assert.strictEqual(s.state.conversations.length, 1);
  assert.strictEqual(s.readWarning, null);
});

console.log('\n带 BOM 的文件（这次事故的元凶）');
check('带 BOM 的 data.json 依然能读回接口（不再被当成空）', () => {
  const dir = freshDir('bom');
  fs.writeFileSync(path.join(dir, 'data.json'), Buffer.concat([BOM, Buffer.from(GOOD, 'utf8')]));
  const s = new Store(dir);
  assert.strictEqual(s.state.connections.length, 1, '接口被读没了');
  assert.strictEqual(s.state.connections[0].name, '我的 DeepSeek');
  assert.strictEqual(s.readWarning, null, '不该报警告，因为内容其实是好的');
});
check('带 BOM 时保存不会把接口写丢', () => {
  const dir = freshDir('bom-save');
  fs.writeFileSync(path.join(dir, 'data.json'), Buffer.concat([BOM, Buffer.from(GOOD, 'utf8')]));
  const s = new Store(dir);
  s.saveNow();
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
  assert.strictEqual(after.connections.length, 1);
  assert.strictEqual(after.connections[0].apiKey, 'sk-real-key');
});
check('自己写出来的文件不带 BOM', () => {
  const dir = freshDir('no-bom-out');
  const s = new Store(dir);
  s.addConnection({ name: 'x', type: 'openai', apiKey: 'sk-1' });
  s.saveNow();
  const buf = fs.readFileSync(path.join(dir, 'data.json'));
  assert.notStrictEqual(buf[0], 0xef, '文件开头是 BOM');
  assert.strictEqual(buf.slice(0, 1).toString(), '{');
});

console.log('\n文件损坏');
check('JSON 被截断时：用默认状态 + 有警告 + 原文件被另存', () => {
  const dir = freshDir('broken');
  fs.writeFileSync(path.join(dir, 'data.json'), GOOD.slice(0, 80), 'utf8');
  const s = new Store(dir);
  assert.strictEqual(s.state.connections.length, 0);
  assert(s.readWarning && s.readWarning.includes('无法解析'), '没有给出警告：' + s.readWarning);
  const quarantined = fs.readdirSync(dir).filter((f) => f.includes('.unreadable-'));
  assert.strictEqual(quarantined.length, 1, '没有另存损坏文件：' + fs.readdirSync(dir).join(','));
  assert.strictEqual(fs.readFileSync(path.join(dir, quarantined[0]), 'utf8'), GOOD.slice(0, 80), '另存内容不一致');
});
check('损坏后保存，另存的副本仍在（数据可人工找回）', () => {
  const dir = freshDir('broken-save');
  fs.writeFileSync(path.join(dir, 'data.json'), '{坏掉的', 'utf8');
  const s = new Store(dir);
  s.saveNow();
  const quarantined = fs.readdirSync(dir).filter((f) => f.includes('.unreadable-'));
  assert.strictEqual(quarantined.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(dir, quarantined[0]), 'utf8'), '{坏掉的');
  assert(JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')).connections, '正式文件应已是合法 JSON');
});
check('内容不是对象（比如是数组）也不崩，走损坏分支', () => {
  const dir = freshDir('array');
  fs.writeFileSync(path.join(dir, 'data.json'), '[1,2,3]', 'utf8');
  const s = new Store(dir);
  assert.strictEqual(s.state.connections.length, 0);
  assert.strictEqual(s.readWarning, null, '数组是合法 JSON，不该报"无法解析"');
});
check('connections 字段类型不对时兜底成空数组而不是崩', () => {
  const dir = freshDir('badtype');
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ version: 1, connections: '不是数组', conversations: 5 }), 'utf8');
  const s = new Store(dir);
  assert.deepStrictEqual(s.state.connections, []);
  assert.deepStrictEqual(s.state.conversations, []);
});
check('空文件按首次运行处理，不算损坏（不产生 .unreadable 副本）', () => {
  const dir = freshDir('empty');
  fs.writeFileSync(path.join(dir, 'data.json'), '', 'utf8');
  const s = new Store(dir);
  assert.strictEqual(s.readWarning, null);
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f.includes('.unreadable-')).length, 0);
});
check('只有空白字符的文件同理', () => {
  const dir = freshDir('blank');
  fs.writeFileSync(path.join(dir, 'data.json'), '   \n\t ', 'utf8');
  const s = new Store(dir);
  assert.strictEqual(s.readWarning, null);
});

console.log('\n导入备份时的 BOM');
check('带 BOM 的备份文件也能解析', () => {
  const exporter = require('../app/lib/exporter');
  const backup = JSON.stringify({
    type: 'better-than-chatbox-backup', formatVersion: 1,
    connections: [{ id: 'a', name: 'A' }], conversations: [],
  });
  const r = exporter.parseBackup('\uFEFF' + backup);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.connections[0].name, 'A');
});

fs.rmSync(ROOT, { recursive: true, force: true });
console.log('\n================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
