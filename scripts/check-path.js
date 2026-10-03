'use strict';

// 诊断工具：把一句话喂进来，看程序会认出哪些本地路径、会怎么处理。
// 用法： node scripts/check-path.js "帮我总结一下 D:\项目A 里的内容"
//
// 排查「我给了地址，AI 说读不到」时先跑这个：它能告诉你到底哪一步没接上。

const fs = require('fs');
const localfs = require('../app/lib/localfs');

const text = process.argv.slice(2).join(' ');
if (!text) {
  console.log('用法： node scripts/check-path.js "你的那句话"');
  process.exit(1);
}

console.log('输入：' + text);
console.log('');

const candidates = localfs.extractCandidatePaths(text);
console.log('① 认出来的「像路径」的片段（共 ' + candidates.length + ' 个）：');
if (!candidates.length) {
  console.log('   （一个都没有 —— 这句话里没有以盘符开头的路径，例如 D:\\xxx 或 \\\\服务器\\共享）');
} else {
  for (const c of candidates) console.log('   · ' + c);
}
console.log('');

const probe = localfs.probeText(text);
console.log('② 其中在本机真实存在、会被读取的（共 ' + probe.items.length + ' 个）：');
if (!probe.items.length) {
  console.log('   （没有 —— 所以这条消息不会带任何文件内容，AI 自然说读不到）');
}
for (const it of probe.items) {
  if (it.kind === 'folder') {
    console.log(`   📁 ${it.path}`);
    console.log(`      ${it.fileCount} 个可读文件，共 ${localfs.humanSize(it.totalBytes)}，跳过 ${it.skippedCount} 项`);
    for (const f of it.files.slice(0, 10)) console.log(`        - ${f.rel}（${localfs.humanSize(f.size)}，${f.kind}）`);
    if (it.files.length > 10) console.log(`        … 还有 ${it.files.length - 10} 个`);
    if (it.skipped.length) {
      console.log('      未读取的：');
      for (const s of it.skipped) console.log(`        × ${s.rel}　${s.reason}`);
    }
  } else if (it.kind === 'file') {
    console.log(`   📄 ${it.path}`);
    console.log(`      类型 ${it.fileKind}，${localfs.humanSize(it.size)}` +
      (it.fileKind === 'other' ? '  ← ⚠️ 这个类型读不出正文，只会把文件名发给 AI' : ''));
  } else if (it.kind === 'image') {
    console.log(`   🖼 ${it.path}（图片：会按视觉消息发，不是读文字）`);
  } else if (it.kind === 'missing') {
    console.log(`   ⛔ ${it.path}`);
    console.log('      本机找不到这个路径 —— 不会被读取（检查拼写、盘符、有没有把这个盘挂上）');
  } else if (it.kind === 'blocked') {
    console.log(`   ⛔ ${it.path} —— ${it.warning}`);
  }
}
console.log('');

// 真正要发给 AI 的东西长什么样
const folders = probe.items.filter((i) => i.kind === 'folder');
const files = probe.items.filter((i) => i.kind === 'file');
for (const f of folders) {
  const r = localfs.readFolderText(f.path);
  console.log('③ 文件夹正文（节选前 600 字）：');
  console.log('----------------------------------------');
  console.log(r.text.slice(0, 600));
  console.log('----------------------------------------');
  console.log(`统计：扫到 ${r.stats.filesScanned} 项，读到 ${r.stats.filesRead} 个文件正文，共 ${r.stats.totalChars} 字符`);
}
for (const f of files) {
  const attachments = require('../app/lib/attachments');
  const info = attachments.classify(require('path').basename(f.path), '');
  const buf = fs.readFileSync(f.path);
  const t = attachments.extractText(buf, info);
  console.log(`③ 文件正文（${f.path}）：${t ? t.slice(0, 300) : '【提不出文字 —— 这种格式读不了正文】'}`);
}

if (!probe.items.length) {
  console.log('③ 结论：这条消息不会附带任何本地文件内容。');
  console.log('   AI 那边只会看到你写的这句话，所以它说「读不到」是正常的 ——');
  console.log('   请检查：路径是否以盘符开头且真实存在、有没有拼错、是不是网络路径。');
}
