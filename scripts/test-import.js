'use strict';

// 导入对话的单元测试
// 用法： node scripts/test-import.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const exporter = require('../app/lib/exporter');
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-import-'));
const existingFile = path.join(tmpDir, '存在的附件.txt');
fs.writeFileSync(existingFile, 'hello', 'utf8');

// 造一个内容比较全的对话（含附件、多版本、思考过程、出错消息）
const conv = {
  id: 'old-1',
  title: '季度总结',
  model: 'deepseek-chat',
  temperature: 0.3,
  systemPrompt: '你是助手',
  createdAt: '2026-09-28T01:00:00.000Z',
  messages: [
    {
      id: 'm1', role: 'user', content: '看看这两个文件', createdAt: '2026-09-28T01:01:00.000Z',
      attachments: [
        { id: 'a1', name: '存在的附件.txt', kind: 'text', size: 5, path: existingFile, text: 'hello', hasText: true },
        { id: 'a2', name: '不存在的图.png', kind: 'image', size: 100, path: 'Z:\\没有\\这个图.png', url: 'file:///Z:/没有/这个图.png', text: '', hasText: false },
        { id: 'a3', name: '项目A', kind: 'folder', size: 1000, path: 'Z:\\别人的电脑\\项目A', fileCount: 3, text: '', hasText: true },
      ],
    },
    { id: 'm2', role: 'assistant', content: '好的，我看到 **两个** 文件。', reasoning: '先看清单', createdAt: '2026-09-28T01:02:00.000Z', attachments: [] },
    {
      id: 'm3', role: 'assistant', content: '当前版本的回答', createdAt: '2026-09-28T01:03:00.000Z', attachments: [],
      variants: [{ content: '第 1 版' }, { content: '当前版本的回答' }], activeVariant: 1,
    },
    { id: 'm4', role: 'assistant', content: '', error: '请求失败 (HTTP 401)', createdAt: '2026-09-28T01:04:00.000Z', attachments: [] },
  ],
};

const exists = (p) => p === existingFile;
const ctx = { appVersion: '1.1.0', connectionName: 'DeepSeek', connectionType: 'openai', defaultModel: 'deepseek-chat' };

console.log('解析导出的 JSON 对话文件');
const jsonExport = JSON.stringify(exporter.conversationToJson(conv, ctx), null, 2);
const fromJson = exporter.parseImportFile(jsonExport, { exists, from: '季度总结.json' });
check('能认出来是对话文件', () => {
  assert.strictEqual(fromJson.ok, true, fromJson.error);
  assert.strictEqual(fromJson.kind, 'conversation');
  assert.strictEqual(fromJson.count, 1);
});
check('生成了新 id（不覆盖原对话）', () => {
  const c = fromJson.conversations[0];
  assert.notStrictEqual(c.id, conv.id);
  assert.notStrictEqual(c.messages[0].id, 'm1');
});
check('标题、模型、温度、系统提示词都带过来', () => {
  const c = fromJson.conversations[0];
  assert.strictEqual(c.title, '季度总结');
  assert.strictEqual(c.model, 'deepseek-chat');
  assert.strictEqual(c.temperature, 0.3);
  assert.strictEqual(c.systemPrompt, '你是助手');
});
check('消息顺序与角色正确', () => {
  const c = fromJson.conversations[0];
  assert.deepStrictEqual(c.messages.map((m) => m.role), ['user', 'assistant', 'assistant', 'assistant']);
  assert.strictEqual(c.messages[0].content, '看看这两个文件');
  assert.strictEqual(c.messages[1].content, '好的，我看到 **两个** 文件。');
});
check('思考过程带过来', () => {
  assert.strictEqual(fromJson.conversations[0].messages[1].reasoning, '先看清单');
});
check('多版本带过来，且选中版本不变', () => {
  const m = fromJson.conversations[0].messages[2];
  assert.strictEqual(m.variants.length, 2);
  assert.strictEqual(m.activeVariant, 1);
  assert.strictEqual(m.content, '当前版本的回答');
});
check('出错消息的 error 带过来', () => {
  assert(/401/.test(fromJson.conversations[0].messages[3].error || ''));
});
check('原文件还在的附件：保留路径', () => {
  const a = fromJson.conversations[0].messages[0].attachments[0];
  assert.strictEqual(a.missing, undefined);
  assert.strictEqual(a.path, existingFile);
  assert.strictEqual(a.text, 'hello');
});
check('原文件不在的图片附件：标 missing 且不再指向本机路径', () => {
  const a = fromJson.conversations[0].messages[0].attachments[1];
  assert.strictEqual(a.missing, true);
  assert.strictEqual(a.url, undefined, '不该留下指向别的电脑的 file:// 地址');
  assert.strictEqual(a.name, '不存在的图.png');
});
check('原文件夹不在本机：也标 missing', () => {
  const a = fromJson.conversations[0].messages[0].attachments[2];
  assert.strictEqual(a.missing, true);
  assert.strictEqual(a.kind, 'folder');
});
check('附件都换了新 id', () => {
  const ids = fromJson.conversations[0].messages[0].attachments.map((a) => a.id);
  assert(ids.every((id) => id && id !== 'a1' && id !== 'a2' && id !== 'a3'), JSON.stringify(ids));
});
check('标了导入来源与时间', () => {
  const c = fromJson.conversations[0];
  assert.strictEqual(c.importedFrom, '季度总结.json');
  assert(c.importedAt && !Number.isNaN(new Date(c.importedAt).getTime()));
});
check('不绑定接口（那是别人机器上的配置）', () => {
  assert.strictEqual(fromJson.conversations[0].connectionId, null);
});

console.log('\n解析整库备份');
const backup = JSON.stringify(exporter.backupObject({
  settings: { theme: 'dark' },
  connections: [{ id: 'c1', name: 'DeepSeek', apiKey: 'sk-x' }],
  activeConnectionId: 'c1',
  conversations: [conv, { id: 'c2', title: '另一个对话', messages: [{ role: 'user', content: 'hi' }] }],
}), null, 2);
const fromBackup = exporter.parseImportFile(backup, { exists });
check('认出来是整库备份', () => {
  assert.strictEqual(fromBackup.ok, true, fromBackup.error);
  assert.strictEqual(fromBackup.kind, 'backup');
  assert.strictEqual(fromBackup.count, 2);
});
check('备份里的对话都能导入（不含接口配置）', () => {
  const titles = fromBackup.conversations.map((c) => c.title);
  assert.deepStrictEqual(titles, ['季度总结', '另一个对话']);
  assert.strictEqual(fromBackup.conversations[0].messages.length, 4);
});
check('导入的对话不带接口（不会牵连别人的 API Key）', () => {
  assert(fromBackup.conversations.every((c) => c.connectionId === null));
});

console.log('\n解析 Markdown（本软件导出的格式）');
const md = exporter.conversationToMarkdown(conv, ctx);
const fromMd = exporter.parseImportMarkdown(md, {});
check('认出来是分段结构', () => {
  assert.strictEqual(fromMd.ok, true, fromMd.error);
  assert.strictEqual(fromMd.parsed, true);
  assert.strictEqual(fromMd.conversations[0].messages.length, 4);
});
check('标题来自第一个 # 标题行', () => {
  assert.strictEqual(fromMd.conversations[0].title, '季度总结');
});
check('角色与正文解析正确', () => {
  const msgs = fromMd.conversations[0].messages;
  assert.strictEqual(msgs[0].role, 'user');
  assert.strictEqual(msgs[0].content, '看看这两个文件');
  assert.strictEqual(msgs[1].role, 'assistant');
  assert.strictEqual(msgs[1].content, '好的，我看到 **两个** 文件。');
});
check('思考过程从折叠块里还原', () => {
  assert.strictEqual(fromMd.conversations[0].messages[1].reasoning, '先看清单');
});
check('附件清单还原成附件（标 missing，因为 md 里没有原文件）', () => {
  const atts = fromMd.conversations[0].messages[0].attachments;
  assert.strictEqual(atts.length, 3, JSON.stringify(atts.map((a) => a.name)));
  assert(atts.every((a) => a.missing));
  assert(atts.some((a) => a.name === '不存在的图.png' && a.kind === 'image'));
});
check('多版本提示行不会被当成正文', () => {
  const m = fromMd.conversations[0].messages[2];
  assert(!/该条消息有 2 个版本/.test(m.content), m.content);
  assert.strictEqual(m.content, '当前版本的回答');
});
check('时间戳解析回本地时间', () => {
  const t = fromMd.conversations[0].messages[0].createdAt;
  assert(t && !Number.isNaN(new Date(t).getTime()), String(t));
});
check('代码块原样保留', () => {
  const withCode = exporter.conversationToMarkdown({
    title: 'x', messages: [{ role: 'assistant', content: '看代码：\n\n```js\nconsole.log(1)\n```\n' }],
  }, {});
  const r = exporter.parseImportMarkdown(withCode, {});
  assert(r.conversations[0].messages[0].content.includes('```js'), r.conversations[0].messages[0].content);
});

console.log('\n解析「不像导出格式」的 Markdown');
const plain = exporter.parseImportMarkdown('# 我的笔记\n\n这是普通 Markdown，没有角色分段。\n', {});
check('不报错，整篇当成一条消息', () => {
  assert.strictEqual(plain.ok, true, plain.error);
  assert.strictEqual(plain.parsed, false);
  assert.strictEqual(plain.conversations[0].messages.length, 1);
  assert(plain.conversations[0].messages[0].content.includes('这是普通 Markdown'));
});
check('标题仍然取自 # 标题行', () => {
  assert.strictEqual(plain.conversations[0].title, '我的笔记');
});
check('空 Markdown 给出报错', () => {
  const r = exporter.parseImportMarkdown('   ', {});
  assert.strictEqual(r.ok, false);
  assert(r.error.includes('没有内容'));
});

console.log('\n坏文件');
check('不是 JSON 的 .json 文件被拒绝', () => {
  const r = exporter.parseImportFile('{坏掉的', { exists });
  assert.strictEqual(r.ok, false);
  assert(r.error.includes('不是合法的 JSON'));
});
check('别人的 JSON 被拒绝', () => {
  const r = exporter.parseImportFile(JSON.stringify({ hello: 1 }), { exists });
  assert.strictEqual(r.ok, false);
  assert(r.error.includes('不是本软件导出的'));
});
check('备份缺 conversations 被拒绝', () => {
  const r = exporter.parseImportFile(JSON.stringify({ type: 'better-than-chatbox-backup' }), { exists });
  assert.strictEqual(r.ok, false);
  assert(r.error.includes('缺少 conversations'));
});
check('只会认带 messages 的裸对象（宽容一点）', () => {
  const r = exporter.parseImportFile(JSON.stringify({ title: '裸对话', messages: [{ role: 'user', content: 'x' }] }), { exists });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.conversations[0].title, '裸对话');
});
check('带 BOM 的 JSON 也能导入', () => {
  const r = exporter.parseImportFile('\uFEFF' + jsonExport, { exists });
  assert.strictEqual(r.ok, true, r.error);
});
check('空备份（0 个对话）被拒绝', () => {
  const r = exporter.parseImportFile(JSON.stringify({ type: 'better-than-chatbox-backup', formatVersion: 1, conversations: [] }), { exists });
  assert.strictEqual(r.ok, false);
  assert(r.error.includes('没有任何对话'));
});

console.log('\n按文件读入（readImportFile）');
const fJson = path.join(tmpDir, 'conv.json');
const fMd = path.join(tmpDir, 'conv.md');
const fPlain = path.join(tmpDir, 'note.md');
fs.writeFileSync(fJson, jsonExport, 'utf8');
fs.writeFileSync(fMd, md, 'utf8');
fs.writeFileSync(fPlain, '# 随手写的笔记\n\n内容。\n', 'utf8');
check('.json 走 JSON 解析', () => {
  const r = exporter.readImportFile(fJson, { exists });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'conversation');
});
check('.md 走 Markdown 解析', () => {
  const r = exporter.readImportFile(fMd, { exists });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'markdown');
  assert.strictEqual(r.parsed, true);
});
check('普通 .md 也能读（整篇一条消息）', () => {
  const r = exporter.readImportFile(fPlain, { exists });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.parsed, false);
});
check('后缀写错但内容是 JSON 也能认', () => {
  const weird = path.join(tmpDir, 'conv.txt');
  fs.writeFileSync(weird, jsonExport, 'utf8');
  const r = exporter.readImportFile(weird, { exists });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'conversation');
});
check('文件不存在给出可读报错', () => {
  const r = exporter.readImportFile(path.join(tmpDir, '没有这个文件.json'), { exists });
  assert.strictEqual(r.ok, false);
  assert(r.error.includes('读不了这个文件'));
});

console.log('\n落库（store.importConversations）');
check('导入的对话排在最前面，且现有对话不受影响', () => {
  const dir = path.join(tmpDir, 'store1');
  const s = new Store(dir);
  const before = s.createConversation({ title: '原有的对话' });
  const imported = fromJson.conversations;
  const added = s.importConversations(imported);
  assert.strictEqual(added.length, 1);
  assert.strictEqual(s.state.conversations[0].title, '季度总结');
  assert.strictEqual(s.state.conversations.length, 2);
  assert(s.state.conversations.some((c) => c.id === before.id), '原有对话被弄丢了');
});
check('导入后每条消息都有多版本结构（分支功能要靠它）', () => {
  const dir = path.join(tmpDir, 'store2');
  const s = new Store(dir);
  const added = s.importConversations(fromJson.conversations);
  for (const m of added[0].messages) {
    assert(Array.isArray(m.variants) && m.variants.length >= 1, JSON.stringify(m));
    assert(typeof m.activeVariant === 'number');
  }
});
check('重新读盘后内容还在（真的写进了 data.json）', () => {
  const dir = path.join(tmpDir, 'store3');
  const s = new Store(dir);
  s.importConversations(fromJson.conversations);
  s.saveNow();
  const s2 = new Store(dir);
  assert.strictEqual(s2.state.conversations.length, 1);
  assert.strictEqual(s2.state.conversations[0].title, '季度总结');
  assert.strictEqual(s2.state.conversations[0].messages.length, 4);
  assert.strictEqual(s2.state.conversations[0].messages[0].attachments.length, 3);
});
check('导出 → 导入 往返后正文完全一致', () => {
  const dir = path.join(tmpDir, 'store4');
  const s = new Store(dir);
  const added = s.importConversations(fromJson.conversations);
  const roundTrip = exporter.conversationToMarkdown(added[0], {});
  const original = exporter.conversationToMarkdown(fromJson.conversations[0], {});
  const stripMeta = (t) => t.split('\n').filter((l) => !/^- (导出时间|软件|接口|模型|消息数|温度|系统提示词)/.test(l)).join('\n');
  assert.strictEqual(stripMeta(roundTrip), stripMeta(original));
});

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
