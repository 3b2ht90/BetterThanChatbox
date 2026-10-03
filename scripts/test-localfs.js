'use strict';

// 本地路径识别 + 文件夹读取的单元测试
// 用法： node scripts/test-localfs.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const localfs = require('../app/lib/localfs');

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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-localfs-'));
const PROJ = path.join(ROOT, '项目A');

function write(rel, content) {
  const p = path.join(PROJ, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// 搭一棵有代表性的目录树
write('README.md', '# 项目说明\n这是一个测试项目。\n');
write('notes.txt', '第一条笔记\n');
write('sub/code.js', 'console.log("hi");\n');
write('sub/deep/inner.md', '# 内层文档\n');
write('a/b/c/level3.txt', '第三层\n');
write('a/b/c/d/level4.txt', '第四层（应被深度限制跳过）\n');
write('node_modules/junk/index.js', 'module.exports = 1;\n');
write('.hidden/secret.txt', '隐藏目录\n');
write('empty.txt', '');
write('data.bin', 'BINARY\u0000\u0001\u0002');
fs.writeFileSync(path.join(PROJ, 'logo.png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

console.log('从文本里认路径');
check('引号包起来的路径（带空格）', () => {
  const r = localfs.extractCandidatePaths('帮我看看 "D:\\我的 文档\\项目" 这个文件夹');
  assert.deepStrictEqual(r, ['D:\\我的 文档\\项目']);
});
check('裸路径', () => {
  const r = localfs.extractCandidatePaths('总结一下 D:\\项目A 里的内容');
  assert.strictEqual(r.length, 1);
  assert(r[0].startsWith('D:\\项目A'));
});
check('正斜杠路径', () => {
  const r = localfs.extractCandidatePaths('读一下 D:/data/report.docx');
  assert.deepStrictEqual(r, ['D:/data/report.docx']);
});
check('UNC 网络路径', () => {
  const r = localfs.extractCandidatePaths('看看 \\\\server\\share\\docs');
  assert.strictEqual(r.length, 1);
  assert(r[0].startsWith('\\\\server\\share'));
});
check('URL 不会被当成路径', () => {
  const r = localfs.extractCandidatePaths('参考 https://github.com/x/y 和 http://a.com/b');
  assert.deepStrictEqual(r, []);
});
check('一段话里多个路径都认出来', () => {
  const r = localfs.extractCandidatePaths('对比 D:\\a 和 E:\\b 两个目录');
  assert.strictEqual(r.length, 2, JSON.stringify(r));
});
check('去掉句尾标点', () => {
  const r = localfs.extractCandidatePaths('路径是 D:\\项目A。');
  assert.strictEqual(r[0], 'D:\\项目A');
});
check('没有路径时返回空数组', () => {
  assert.deepStrictEqual(localfs.extractCandidatePaths('你好，帮我写首诗'), []);
});
check('中文全角引号也能识别', () => {
  const r = localfs.extractCandidatePaths('读取「D:\\我的 项目」里的文件');
  assert.deepStrictEqual(r, ['D:\\我的 项目']);
});

console.log('\n把候选串收敛成真实存在的路径（注入假的存在性判断）');
check('带空格时靠"往短了试"定边界', () => {
  const exists = (p) => p === 'D:\\项目A';
  assert.strictEqual(localfs.longestExistingPath('D:\\项目A 里的文档', exists), 'D:\\项目A');
});
check('整串就存在时原样返回', () => {
  const exists = (p) => p === 'D:\\项目A\\README.md';
  assert.strictEqual(localfs.longestExistingPath('D:\\项目A\\README.md', exists), 'D:\\项目A\\README.md');
});
check('一层层往上退', () => {
  const exists = (p) => p === 'D:\\a\\b';
  assert.strictEqual(localfs.longestExistingPath('D:\\a\\b\\c\\d e f.txt', exists), 'D:\\a\\b');
});
check('全都不存在时返回 null', () => {
  assert.strictEqual(localfs.longestExistingPath('Z:\\没有\\这个\\东西', () => false), null);
});
check('剥掉外层引号', () => {
  const exists = (p) => p === 'D:\\我的 项目';
  assert.strictEqual(localfs.longestExistingPath('"D:\\我的 项目"', exists), 'D:\\我的 项目');
});

console.log('\n危险路径拦截');
check('盘符根目录被拦', () => {
  assert(localfs.riskyReason('C:\\'), 'C:\\ 应被拦');
  assert(localfs.riskyReason('D:\\'));
});
check('Windows 系统目录被拦', () => {
  assert(localfs.riskyReason(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')));
});
check('普通目录不拦', () => {
  assert.strictEqual(localfs.riskyReason(PROJ), null);
});

console.log('\n扫描文件夹');
const listed = localfs.listFolder(PROJ);
const rels = listed.files.map((f) => f.rel).sort();
check('读到可读文件', () => {
  assert(rels.includes('README.md'), JSON.stringify(rels));
  assert(rels.includes('notes.txt'));
  assert(rels.includes('sub/code.js'));
  assert(rels.includes('sub/deep/inner.md'));
  assert(rels.includes('a/b/c/level3.txt'));
});
check('跳过 node_modules', () => {
  assert(!rels.some((r) => r.includes('node_modules')), JSON.stringify(rels));
  assert(listed.skipped.some((s) => s.rel.includes('node_modules')));
});
check('跳过隐藏目录', () => {
  assert(!rels.some((r) => r.includes('.hidden')));
});
check('超出深度的目录被跳过并记录原因', () => {
  assert(!rels.includes('a/b/c/d/level4.txt'), JSON.stringify(rels));
  const s = listed.skipped.find((x) => x.rel.includes('level4') || x.rel === 'a/b/c/d/');
  assert(s, '没记录被深度限制跳过的目录');
});
check('图片不读正文但列出来', () => {
  assert(!rels.includes('logo.png'));
  assert(listed.skipped.some((s) => s.rel === 'logo.png' && /图片/.test(s.reason)));
});
check('空文件照常进清单（是否读得到正文由提取阶段决定）', () => {
  assert(rels.includes('empty.txt'));
});
check('返回名字与总体积', () => {
  assert.strictEqual(listed.name, '项目A');
  assert(listed.totalBytes > 0);
});
check('文件数上限生效', () => {
  const small = localfs.listFolder(PROJ, { maxFiles: 2 });
  assert.strictEqual(small.files.length, 2);
  assert.strictEqual(small.truncated, true);
});
check('单文件大小上限生效', () => {
  const tiny = localfs.listFolder(PROJ, { maxFileBytes: 10 });
  assert(!tiny.files.some((f) => f.rel === 'README.md'), '大文件应被排出');
  assert(tiny.skipped.some((s) => /过大/.test(s.reason)));
});

console.log('\n拼给 AI 的正文');
const read = localfs.readFolderText(PROJ);
check('带文件夹概览头', () => {
  assert(read.text.includes('[文件夹] ' + PROJ), read.text.slice(0, 80));
  assert(/共扫描到 \d+ 个条目/.test(read.text));
});
check('每个文件有分隔标题', () => {
  assert(read.text.includes('===== 1/'), '没有分节标题');
  assert(read.text.includes('README.md'));
});
check('正文内容确实读出来了', () => {
  assert(read.text.includes('这是一个测试项目。'));
  assert(read.text.includes('console.log("hi");'));
});
check('统计数字自洽', () => {
  assert.strictEqual(read.stats.filesRead > 0, true);
  assert.strictEqual(read.stats.filesScanned, listed.files.length + listed.skipped.length);
  assert(read.stats.totalChars > 0);
});
check('跳过项在概览里列了名字（让 AI 知道目录里还有什么）', () => {
  assert(read.text.includes('logo.png'), '未列出被跳过的文件');
  assert(read.text.includes('未提供正文的条目'));
});
check('正文上限生效并标注', () => {
  const r2 = localfs.readFolderText(PROJ, { maxTotalChars: 20 });
  assert(r2.stats.totalChars <= 20, String(r2.stats.totalChars));
  assert(r2.text.includes('达到上限'), r2.text.slice(0, 300));
});
check('单文件上限生效并标注截断', () => {
  const r3 = localfs.readFolderText(PROJ, { maxPerFileChars: 5 });
  assert(r3.text.includes('已截断'), r3.text.slice(0, 300));
});
check('空文件夹给出说明而不是空白', () => {
  const emptyDir = path.join(ROOT, '空目录');
  fs.mkdirSync(emptyDir, { recursive: true });
  const r4 = localfs.readFolderText(emptyDir);
  assert(r4.text.includes('没有能读取正文的文件'), r4.text);
});

console.log('\n探测 + 变成附件');
check('探测输入框文本，认出文件夹并给出清单', () => {
  const res = localfs.probeText('帮我总结 ' + PROJ + ' 里的内容');
  assert.strictEqual(res.items.length, 1, JSON.stringify(res.items));
  const it = res.items[0];
  assert.strictEqual(it.kind, 'folder');
  assert.strictEqual(it.name, '项目A');
  assert(it.fileCount > 0);
  assert(Array.isArray(it.files));
});
check('探测单个文件', () => {
  const res = localfs.probeText('看看 ' + path.join(PROJ, 'notes.txt'));
  assert.strictEqual(res.items[0].kind, 'file');
  assert.strictEqual(res.items[0].fileKind, 'text');
});
check('探测图片文件', () => {
  const res = localfs.probeText('看看 ' + path.join(PROJ, 'logo.png'));
  assert.strictEqual(res.items[0].kind, 'image');
});
check('探测盘符根目录 → blocked（说明是根目录不扫）', () => {
  const res = localfs.probeText('看看 C:\\');
  assert.strictEqual(res.items[0].kind, 'blocked', JSON.stringify(res.items));
  assert(/根目录/.test(res.items[0].warning), res.items[0].warning);
});
check('不存在的路径会明确报出来，而不是默默忽略', () => {
  const res = localfs.probeText('看看 Z:\\不存在的目录\\x');
  assert.strictEqual(res.items.length, 1, JSON.stringify(res.items));
  assert.strictEqual(res.items[0].kind, 'missing');
  assert(res.items[0].warning.includes('找不到'));
});
check('盘符存在、子路径不存在 → 也是 missing（不能报成「根目录不扫」）', () => {
  const root = path.parse(PROJ).root;
  const res = localfs.probeText('读一下 ' + root + '这个不存在的目录xyz');
  assert.strictEqual(res.items[0].kind, 'missing', JSON.stringify(res.items));
});
check('中文紧贴路径也要认出来（读取D:\\项目A）', () => {
  const res = localfs.probeText('读取' + PROJ + '里的内容');
  assert.strictEqual(res.items.length, 1, JSON.stringify(res.items));
  assert.strictEqual(res.items[0].kind, 'folder');
  assert.strictEqual(res.items[0].path, PROJ, res.items[0].path);
});
check('中文紧贴文件路径也要认出来（总结X\\说明.md这个文件）', () => {
  const f = path.join(PROJ, 'notes.txt');
  const res = localfs.probeText('总结' + f + '这个文件');
  assert.strictEqual(res.items.length, 1, JSON.stringify(res.items));
  assert.strictEqual(res.items[0].path, f, res.items[0].path);
});
check('路径后面紧跟中文时也能切对边界', () => {
  const res = localfs.probeText('看看' + PROJ + '这个文件夹');
  assert.strictEqual(res.items[0].path, PROJ, JSON.stringify(res.items));
});
check('URL 依然不会被当成路径', () => {
  const res = localfs.probeText('参考 https://github.com/a/b 和 D:\\真路径');
  assert(res.items.every((i) => i.kind !== 'missing' || !i.path.includes('github')), JSON.stringify(res.items));
});
check('文件夹附件元数据：只存路径和清单，不存正文', () => {
  const item = localfs.probeText('读 ' + PROJ).items[0];
  const att = localfs.folderToAttachment(item);
  assert.strictEqual(att.kind, 'folder');
  assert.strictEqual(att.path, PROJ);
  assert.strictEqual(att.text, '', '正文不该存进 data.json');
  assert.strictEqual(att.fileCount, item.fileCount);
  assert(att.id && att.id.length > 10);
});

console.log('\n拼进请求体（三种协议都要带上）');
const providers = require('../app/lib/providers');
const att = localfs.folderToAttachment(localfs.probeText('读 ' + PROJ).items[0]);
const fakePng = path.join(PROJ, 'logo.png');
const messages = [{ role: 'user', content: '总结这个文件夹', attachments: [att] }];

const captured = [];
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  captured.push({ url: String(url), body: JSON.parse(opts.body) });
  return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

const conn = { id: 'c1', name: 't', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'm' };

(async () => {
  try {
    await providers.streamChat({
      connection: conn, model: '', systemPrompt: '', temperature: 0.7,
      messages, onDelta: () => {}, onReasoning: () => {},
    });
    const text = captured[0].body.messages[0].content;
    check('文件夹正文真的进了请求体', () => {
      assert(text.includes('这是一个测试项目。'), '没带上文件正文');
      assert(text.includes('文件夹：' + PROJ), '没有文件夹分隔标记');
      assert(text.includes('文件夹结束'), '缺结束标记');
    });
    check('概览头也带上（让 AI 知道有哪些没读的）', () => {
      assert(text.includes('未提供正文的条目'));
    });
  } catch (err) {
    check('请求构造没抛异常', () => { throw err; });
  } finally {
    global.fetch = realFetch;
    fs.rmSync(ROOT, { recursive: true, force: true });
    console.log('\n================');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
  }
})();
