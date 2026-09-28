'use strict';

// docx / xlsx / pptx 提取的验证脚本
// 用法： node scripts/test-office.js [样本目录]
//
// 样本由 scripts/make-office-fixtures.py 用 python-docx / python-pptx / openpyxl 生成，
// 内容是我们自己写死的，所以可以直接做「提取结果必须包含这些字符串」的断言。

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const officedoc = require('../app/lib/officedoc');
const attachments = require('../app/lib/attachments');
const { MAX_TEXT_CHARS } = require('../app/lib/store');

const dir = process.argv[2] || path.join(__dirname, '..', 'test-artifacts', 'office');

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''));
  }
}

function extractFile(file) {
  const buf = fs.readFileSync(file);
  const info = attachments.classify(path.basename(file), '');
  const text = attachments.extractText(buf, info);
  return { buf, info, text };
}

function has(text, needle) {
  return text.indexOf(needle) !== -1;
}

// ---------- 合成一个 stored（不压缩）方式的 zip，验证 ZIP 读取器的另一条分支 ----------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function zipStore(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8); // method 0 = stored
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    local.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 10); // method 0
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);

    offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, eocd]);
}

console.log('样本目录：' + dir + '\n');

// ---------- docx ----------
const docxFile = path.join(dir, 'sample.docx');
if (fs.existsSync(docxFile)) {
  console.log('docx（python-docx 生成）');
  const { info, text } = extractFile(docxFile);
  check('分类为 office 且扩展名正确', info.kind === 'office' && info.ext === '.docx', JSON.stringify(info));
  check('标题「季度报告 Quarter Report」', has(text, '季度报告 Quarter Report'));
  check('中文段落「第一段：中文内容测试 123。」', has(text, '第一段：中文内容测试 123。'));
  check('XML 实体还原：& < > " \'', has(text, '特殊字符 & < > " \' 以及全角（括号）'));
  check('表格单元格「表头A」', has(text, '表头A'));
  check('表格单元格「value 2」', has(text, 'value 2'));
  check('结尾段落', has(text, '最后一段结尾。'));
  check('段落按行分开（不只是拼成一行）', text.split('\n').length >= 6, '实际 ' + text.split('\n').length + ' 行');
  console.log('  --- 提取结果 ---');
  console.log(text.split('\n').map((l) => '  | ' + l).join('\n'));
} else {
  check('sample.docx 存在', false, docxFile);
}

// ---------- xlsx ----------
const xlsxFile = path.join(dir, 'sample.xlsx');
if (fs.existsSync(xlsxFile)) {
  console.log('\nxlsx（openpyxl 生成，含共享字符串）');
  const { info, text } = extractFile(xlsxFile);
  check('分类为 office 且扩展名正确', info.kind === 'office' && info.ext === '.xlsx', JSON.stringify(info));
  check('表头「姓名」', has(text, '姓名'));
  check('共享字符串「张三」', has(text, '张三'));
  check('数字单元格 42', has(text, '42'));
  check('浮点 99.5', has(text, '99.5'));
  check('第二个工作表的内容', has(text, '表二内容'));
  check('按单元格用制表符分隔', has(text, '姓名\t分数'));
  console.log('  --- 提取结果 ---');
  console.log(text.split('\n').map((l) => '  | ' + l).join('\n'));
} else {
  console.log('\nxlsx：样本不存在（可能没装 openpyxl），跳过');
}

// ---------- pptx ----------
const pptxFile = path.join(dir, 'sample.pptx');
if (fs.existsSync(pptxFile)) {
  console.log('\npptx（python-pptx 生成）');
  const { info, text } = extractFile(pptxFile);
  check('分类为 office 且扩展名正确', info.kind === 'office' && info.ext === '.pptx', JSON.stringify(info));
  check('第 1 页标题「演示标题 Slide Title」', has(text, '演示标题 Slide Title'));
  check('第 1 页副标题', has(text, '副标题 bullet one'));
  check('第 2 页标题「第二页」', has(text, '第二页'));
  check('第 2 页正文「要点一」', has(text, '要点一'));
  check('标注了页码', has(text, '第 1 页') && has(text, '第 2 页'));
  console.log('  --- 提取结果 ---');
  console.log(text.split('\n').map((l) => '  | ' + l).join('\n'));
} else {
  check('sample.pptx 存在', false, pptxFile);
}

// ---------- 真实第三方文件 ----------
// 这两个是 python-docx / python-pptx 自带的空白模板：
//   default.docx 的 document.xml 里没有任何 <w:t>；default.pptx 里 0 张幻灯片。
// 所以「提取到 0 字符」才是正确结果 —— 这里连"它本来就是空的"一起断言，
// 将来模板变了或者解析器漏读，都能立刻发现。
console.log('\n真实第三方文件（python 包自带的模板，本身是空白的）');
const realDocx = path.join(dir, 'real-template.docx');
if (fs.existsSync(realDocx)) {
  const buf = fs.readFileSync(realDocx);
  const zip = officedoc.openZip(buf);
  const xml = zip.read('word/document.xml').toString('utf8');
  const { text } = extractFile(realDocx);
  check('是合法 docx（能被 ZIP 读取器打开）', zip.names.includes('word/document.xml'));
  check('模板确实没有任何 <w:t> 文本节点', !/<w:t[ >]/.test(xml));
  check('因此提取结果为 0 字符是正确行为', text === '');
} else {
  console.log('  （跳过 real-template.docx：未随仓库提交，用 make-office-fixtures.py 可生成）');
}
const realPptx = path.join(dir, 'real-template.pptx');
if (fs.existsSync(realPptx)) {
  const buf = fs.readFileSync(realPptx);
  const zip = officedoc.openZip(buf);
  const slides = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const { text } = extractFile(realPptx);
  check('是合法 pptx（能被 ZIP 读取器打开）', zip.names.includes('ppt/presentation.xml'));
  check('模板里确实一张幻灯片都没有', slides.length === 0);
  check('因此提取结果为 0 字符是正确行为', text === '');
} else {
  console.log('  （跳过 real-template.pptx：未随仓库提交，用 make-office-fixtures.py 可生成）');
}

// ---------- 非 ZIP 的老格式 .doc ----------
console.log('\n异常输入');
const legacy = path.join(dir, 'legacy.doc');
if (fs.existsSync(legacy)) {
  const { info, text } = extractFile(legacy);
  check('.doc 归类为 other（只发文件名）', info.kind === 'other', JSON.stringify(info));
  check('.doc 不报错、返回空文本', text === '');
}
const fakeDocx = path.join(dir, 'broken.docx');
fs.writeFileSync(fakeDocx, '这不是一个 zip 文件');
const broken = extractFile(fakeDocx);
check('损坏的 .docx 不抛异常、返回空文本', broken.text === '');
check('损坏的 .docx 仍归类为 office（会提示提取不到文字）', broken.info.kind === 'office');

// ---------- stored（不压缩）方式的 zip ----------
console.log('\nZIP 读取器分支');
const storedZip = zipStore([
  {
    name: 'word/document.xml',
    data: '<?xml version="1.0"?><w:document><w:body>' +
      '<w:p><w:r><w:t>StoredMethodOK</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>第二行 stored</w:t></w:r></w:p>' +
      '</w:body></w:document>',
  },
  { name: 'word/_rels/document.xml.rels', data: '<?xml version="1.0"?><Relationships/>' },
]);
const storedText = officedoc.extract(storedZip, '.docx', MAX_TEXT_CHARS);
check('stored（method 0）压缩也能解', has(storedText, 'StoredMethodOK'));
check('stored 多段落正确分行', has(storedText, '第二行 stored'));

// ---------- 长度上限 ----------
const longDoc = zipStore([
  { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:r><w:t>' + 'A'.repeat(500) + '</w:t></w:r></w:p></w:body></w:document>' },
]);
check('遵守字符数上限', officedoc.extract(longDoc, '.docx', 100).length === 100);

console.log('\n================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
