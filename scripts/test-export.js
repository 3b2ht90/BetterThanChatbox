'use strict';

// 导出 / 备份功能的测试
// 用法： node scripts/test-export.js

const assert = require('assert');
const exporter = require('../app/lib/exporter');

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

// ---------- 造一个带各种情况的对话 ----------
const conv = {
  id: 'c1',
  title: '季度总结/Q3：测试 <标签>',
  model: 'deepseek-chat',
  temperature: 0.3,
  systemPrompt: '你是一个测试助手\n只回答要点',
  messages: [
    {
      id: 'm1',
      role: 'user',
      content: '帮我看看这个文档',
      createdAt: '2026-09-28T01:02:03.000Z',
      attachments: [
        { name: '报告.docx', kind: 'office', size: 36943, hasText: true },
        { name: '截图.png', kind: 'image', size: 20480, hasText: false },
        { name: 'note.txt', kind: 'text', size: 54, hasText: true },
        { name: 'data.bin', kind: 'other', size: 900, hasText: false },
        { name: '扫描件.pdf', kind: 'pdf', size: 120000, hasText: false },
      ],
    },
    {
      id: 'm2',
      role: 'assistant',
      content: '好的，这是**结论**：\n\n```js\nconsole.log(1)\n```',
      reasoning: '先看目录，再看正文',
      createdAt: '2026-09-28T01:02:05.000Z',
      attachments: [],
    },
    {
      id: 'm3',
      role: 'assistant',
      content: '当前选中的第 2 版回答',
      variants: [{ content: '第 1 版' }, { content: '当前选中的第 2 版回答' }],
      activeVariant: 1,
      createdAt: '2026-09-28T01:02:07.000Z',
      attachments: [],
    },
    { id: 'm4', role: 'assistant', content: '', error: '请求失败 (HTTP 401)：无效的 Key', createdAt: '2026-09-28T01:02:09.000Z', attachments: [] },
  ],
};

const ctx = { appVersion: '1.0.0', connectionName: 'DeepSeek', connectionType: 'openai', defaultModel: 'deepseek-chat' };

console.log('Markdown 导出');
const md = exporter.conversationToMarkdown(conv, ctx);

check('标题是 H1', () => assert(md.startsWith('# 季度总结/Q3：测试 <标签>\n'), md.slice(0, 60)));
check('带导出时间和软件版本', () => assert(md.includes('- 软件：BetterThanChatbox 1.0.0') && md.includes('- 导出时间：')));
check('带接口与模型', () => assert(md.includes('- 接口：DeepSeek（openai）') && md.includes('- 模型：deepseek-chat')));
check('带温度与系统提示词（换行被压平）', () =>
  assert(md.includes('- 温度：0.3') && md.includes('- 系统提示词：你是一个测试助手 只回答要点')));
check('用户消息标题', () => assert(md.includes('## 👤 用户')));
check('AI 消息标题', () => assert(md.includes('## 🤖 AI')));
check('正文原样保留（含代码块和粗体）', () =>
  assert(md.includes('好的，这是**结论**：\n\n```js\nconsole.log(1)\n```')));
check('附件列出 5 个且带大小', () => {
  const n = (md.match(/^- (图片|文本|PDF|Office 文档|文件)：/gm) || []).length;
  assert.strictEqual(n, 5, '实际 ' + n + ' 行');
  assert(md.includes('`报告.docx`（36.1 KB，内容已发送给 AI）'), '缺 docx 行');
  assert(md.includes('`截图.png`（20.0 KB，以图片形式发给 AI）'), '缺图片行');
  assert(md.includes('`data.bin`（900 B，只发了文件名）'), '缺 other 行');
  assert(md.includes('`扫描件.pdf`（117.2 KB，未能提取文字（只发了文件名））'), '缺扫描件行');
});
check('思考过程放进折叠块', () =>
  assert(md.includes('<details><summary>思考过程</summary>') && md.includes('先看目录，再看正文')));
check('多版本消息有提示，且导出的是当前选中那版', () => {
  assert(md.includes('该条消息有 2 个版本，下面导出的是当前选中的第 2 版。'));
  assert(md.includes('当前选中的第 2 版回答'));
  assert(!md.includes('第 1 版\n'), '不应导出未选中的版本');
});
check('出错消息被标注', () => assert(md.includes('> ⚠️ 出错：请求失败 (HTTP 401)：无效的 Key')));
check('没有连续 4 个以上空行', () => assert(!/\n{4,}/.test(md)));
check('结尾有换行', () => assert(md.endsWith('\n')));

console.log('\nMarkdown 边界情况');
check('空对话给出说明而不是空白', () => {
  const t = exporter.conversationToMarkdown({ title: '空', messages: [] }, ctx);
  assert(t.includes('*（这个对话还没有消息）*'), t);
});
check('标题为空时用兜底文案', () => {
  const t = exporter.conversationToMarkdown({ messages: [] }, ctx);
  assert(t.startsWith('# 未命名对话'), t.slice(0, 40));
});
check('没有 model 时标注接口默认', () => {
  const t = exporter.conversationToMarkdown({ title: 'x', messages: [] }, ctx);
  assert(t.includes('- 模型：deepseek-chat（接口默认）'), t);
});
check('空消息标成 (空消息)', () => {
  const t = exporter.conversationToMarkdown({ title: 'x', messages: [{ role: 'assistant', content: '', attachments: [] }] }, ctx);
  assert(t.includes('*（空消息）*'));
});

console.log('\nJSON 导出');
check('带类型与格式版本，便于以后识别', () => {
  const j = exporter.conversationToJson(conv, ctx);
  assert.strictEqual(j.type, 'better-than-chatbox-conversation');
  assert.strictEqual(j.formatVersion, 1);
  assert.strictEqual(j.conversation.id, 'c1');
});
check('保留变体等全部字段（不是有损导出）', () => {
  const j = exporter.conversationToJson(conv, ctx);
  assert.strictEqual(j.conversation.messages[2].variants.length, 2);
  assert.strictEqual(j.conversation.messages[2].activeVariant, 1);
});
check('可被 JSON.stringify 序列化', () => assert(JSON.stringify(exporter.conversationToJson(conv, ctx)).length > 100));

console.log('\n整体备份');
const state = {
  settings: { defaultTemperature: 0.7, theme: 'dark' },
  connections: [{ id: 'c1', name: 'DeepSeek', apiKey: 'sk-xxx' }],
  activeConnectionId: 'c1',
  conversations: [conv],
};
const backup = exporter.backupObject(state, '1.0.0');
check('带类型标记', () => assert.strictEqual(backup.type, 'better-than-chatbox-backup'));
check('统计数量正确', () => assert.deepStrictEqual(backup.counts, { connections: 1, conversations: 1, messages: 4 }));
check('包含接口配置（含 Key）', () => assert.strictEqual(backup.connections[0].apiKey, 'sk-xxx'));
check('包含设置与当前接口', () => assert.strictEqual(backup.settings.theme, 'dark') && assert.strictEqual(backup.activeConnectionId, 'c1'));

console.log('\n备份文件校验（parseBackup）');
check('自己的备份能通过', () => assert.strictEqual(exporter.parseBackup(JSON.stringify(backup)).ok, true));
check('非法 JSON 被拒绝', () => {
  const r = exporter.parseBackup('{不是 json');
  assert.strictEqual(r.ok, false);
  assert(r.error.includes('不是合法的 JSON'), r.error);
});
check('别人的 JSON 被拒绝', () => {
  const r = exporter.parseBackup(JSON.stringify({ hello: 1 }));
  assert.strictEqual(r.ok, false);
  assert(r.error.includes('不是本软件导出的备份文件'), r.error);
});
check('缺字段被拒绝', () => {
  const r = exporter.parseBackup(JSON.stringify({ type: 'better-than-chatbox-backup', connections: [] }));
  assert.strictEqual(r.ok, false);
  assert(r.error.includes('缺少'), r.error);
});
check('未来版本被拒绝', () => {
  const bad = { ...backup, formatVersion: 99 };
  const r = exporter.parseBackup(JSON.stringify(bad));
  assert.strictEqual(r.ok, false);
  assert(r.error.includes('比当前软件更新'), r.error);
});
check('单对话导出文件不会被误当成整库备份', () => {
  const r = exporter.parseBackup(JSON.stringify(exporter.conversationToJson(conv, ctx)));
  assert.strictEqual(r.ok, false);
});

console.log('\n文件名与时间');
check('文件名里的非法字符被替换', () => {
  assert.strictEqual(exporter.safeFileName('季度总结/Q3：测试 <标签>'), '季度总结_Q3：测试 _标签_');
});
check('超长标题被截断', () => assert(exporter.safeFileName('啊'.repeat(200)).length <= 60));
check('空标题有兜底', () => assert.strictEqual(exporter.safeFileName('', '对话'), '对话'));
check('纯空白标题有兜底', () => assert.strictEqual(exporter.safeFileName('   ', '对话'), '对话'));
check('时间格式正确', () => {
  const t = exporter.fmtTime('2026-09-28T01:02:03.000Z');
  assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t), t);
});
check('非法时间不抛异常', () => assert.strictEqual(exporter.fmtTime('不是时间'), '不是时间'));
check('空时间返回空串', () => assert.strictEqual(exporter.fmtTime(''), ''));

console.log('\n落盘（真写文件再读回来）');
const os = require('os');
const fs = require('fs');
const path = require('path');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-export-'));

check('导出 .md 后文件内容与生成的一致', () => {
  const f = path.join(tmpDir, '对话.md');
  const res = exporter.writeConversationFile(f, conv, ctx);
  assert.strictEqual(res.format, 'markdown');
  const onDisk = fs.readFileSync(f, 'utf8');
  assert.strictEqual(onDisk, exporter.conversationToMarkdown(conv, ctx));
  assert.strictEqual(res.bytes, Buffer.byteLength(onDisk, 'utf8'));
});
check('导出 .json 后是合法 JSON 且能解析回对话', () => {
  const f = path.join(tmpDir, '对话.json');
  const res = exporter.writeConversationFile(f, conv, ctx);
  assert.strictEqual(res.format, 'json');
  const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(parsed.conversation.messages.length, 4);
});
check('中文文件名与内容不乱码（UTF-8）', () => {
  const f = path.join(tmpDir, '季度总结 测试.md');
  exporter.writeConversationFile(f, conv, ctx);
  assert(fs.existsSync(f), '中文文件名写不出来');
  const t = fs.readFileSync(f, 'utf8');
  assert(t.includes('帮我看看这个文档'), '中文正文丢了');
  assert(t.includes('季度总结/Q3：测试 <标签>'), '中文标题丢了');
});
check('.txt 也走 Markdown 格式（用户手动选了纯文本）', () => {
  const f = path.join(tmpDir, '导出.txt');
  const res = exporter.writeConversationFile(f, conv, ctx);
  assert.strictEqual(res.format, 'markdown');
});
check('整库备份落盘后可被 parseBackup 解析回来', () => {
  const f = path.join(tmpDir, '备份.json');
  const res = exporter.writeBackupFile(f, state, '1.0.0');
  assert.deepStrictEqual(res.counts, { connections: 1, conversations: 1, messages: 4 });
  const parsed = exporter.parseBackup(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.data.connections[0].name, 'DeepSeek');
  assert.strictEqual(parsed.data.conversations[0].messages.length, 4);
});
check('路径不存在时报错而不是静默失败', () => {
  assert.throws(() => exporter.writeConversationFile(path.join(tmpDir, '没有这个目录', 'x.md'), conv, ctx));
});
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('\n================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
