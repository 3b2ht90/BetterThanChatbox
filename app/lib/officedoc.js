'use strict';

// Office 文档（docx / xlsx / pptx）文本提取。
//
// 这三种格式本质都是 ZIP + XML，所以不需要任何第三方依赖：
// 用 Node 内置 zlib 解 ZIP（支持 stored / deflate 两种压缩），再按各自的 XML 结构取文字。
//
// 不支持老格式 .doc / .xls / .ppt（二进制 OLE 复合文档），那种需要专门的解析库。

const zlib = require('zlib');

const OFFICE_EXT = { '.docx': 'docx', '.xlsx': 'xlsx', '.pptx': 'pptx' };

const OFFICE_MIME = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// ---------------- 最小 ZIP 读取器 ----------------

function findEocd(buf) {
  // 中央目录结束记录：0x06054b50，从文件尾部往前找（注释最长 65535）
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen <= buf.length) return i;
    }
  }
  return -1;
}

function openZip(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP 包（未找到 EOCD），可能文件损坏或是老格式');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const index = new Map();

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    index.set(name, { method, compSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    names: Array.from(index.keys()),
    read(name) {
      const entry = index.get(name);
      if (!entry) return null;
      if (entry.compSize === 0xffffffff) throw new Error('ZIP64 格式暂不支持（文件超过 4GB）');
      const lp = entry.localOff;
      if (lp + 30 > buf.length || buf.readUInt32LE(lp) !== 0x04034b50) return null;
      const nameLen = buf.readUInt16LE(lp + 26);
      const extraLen = buf.readUInt16LE(lp + 28);
      const start = lp + 30 + nameLen + extraLen;
      const data = buf.slice(start, start + entry.compSize);
      if (entry.method === 0) return data; // stored
      if (entry.method === 8) return zlib.inflateRawSync(data); // deflate
      throw new Error('不支持的 ZIP 压缩方式：' + entry.method);
    },
  };
}

// ---------------- XML 小工具 ----------------

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const code = Number(d);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&amp;/g, '&'); // & 必须最后处理
}

/** 取出一段 XML 里所有 <tag ...>text</tag> 的文字并拼接 */
function collectTags(xml, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function tidy(text, limit) {
  const cleaned = String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.slice(0, limit);
}

function sheetNumber(name) {
  const m = /(\d+)\.xml$/.exec(name);
  return m ? Number(m[1]) : 0;
}

// ---------------- docx ----------------

function docxToText(buf, limit) {
  const zip = openZip(buf);
  const xml = zip.read('word/document.xml');
  if (!xml) return '';

  let s = xml.toString('utf8');
  s = s.replace(/<w:tab\b[^>]*\/?>/g, '\t');
  s = s.replace(/<w:br\b[^>]*\/?>/g, '\n');
  s = s.replace(/<w:cr\b[^>]*\/?>/g, '\n');

  // 每个 </w:p> 是一段（表格单元格里的段落也会各成一行）
  const chunks = s.split(/<\/w:p>/);
  const lines = [];
  for (const chunk of chunks) {
    const texts = collectTags(chunk, 'w:t').map((t) => decodeEntities(t));
    const line = texts.join('').replace(/\s+$/, '');
    lines.push(line);
  }
  // 去掉开头（body 之前）和结尾产生的空行
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return tidy(lines.join('\n'), limit);
}

// ---------------- xlsx ----------------

function xlsxToText(buf, limit) {
  const zip = openZip(buf);

  // 共享字符串表
  const shared = [];
  const ssXml = zip.read('xl/sharedStrings.xml');
  if (ssXml) {
    const s = ssXml.toString('utf8');
    for (const si of collectTags(s, 'si')) {
      shared.push(decodeEntities(collectTags(si, 't').join('')));
    }
  }

  const sheets = zip.names
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => sheetNumber(a) - sheetNumber(b));

  const out = [];
  sheets.forEach((name, idx) => {
    const xml = zip.read(name).toString('utf8');
    const rows = xml.split(/<\/row>/);
    const lines = [];
    for (const row of rows) {
      // 先干掉自闭合空单元格，避免正则跨行误配
      const cleaned = row.replace(/<c\b[^>]*\/>/g, '');
      const cells = [];
      const re = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let m;
      while ((m = re.exec(cleaned)) !== null) {
        const attrs = m[1];
        const inner = m[2];
        const typeMatch = /\bt="([^"]+)"/.exec(attrs);
        const type = typeMatch ? typeMatch[1] : 'n';
        let value = '';
        if (type === 's') {
          const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
          const i = v ? Number(decodeEntities(v[1])) : NaN;
          value = Number.isFinite(i) && shared[i] != null ? shared[i] : '';
        } else if (type === 'inlineStr') {
          value = decodeEntities(collectTags(inner, 't').join(''));
        } else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
          value = v ? decodeEntities(v[1]) : '';
        }
        cells.push(value);
      }
      const line = cells.join('\t').replace(/[\t\s]+$/, '');
      if (line.trim()) lines.push(line);
    }
    if (lines.length) {
      out.push(sheets.length > 1 ? `### 工作表 ${idx + 1}\n${lines.join('\n')}` : lines.join('\n'));
    }
  });

  return tidy(out.join('\n\n'), limit);
}

// ---------------- pptx ----------------

function pptxToText(buf, limit) {
  const zip = openZip(buf);
  const slides = zip.names
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => sheetNumber(a) - sheetNumber(b));

  const out = [];
  slides.forEach((name, idx) => {
    const xml = zip.read(name).toString('utf8');
    const texts = collectTags(xml, 'a:t').map((t) => decodeEntities(t));
    const body = texts.map((t) => t.trim()).filter(Boolean).join('\n');
    if (body) out.push(`--- 第 ${idx + 1} 页 ---\n${body}`);
  });

  return tidy(out.join('\n\n'), limit);
}

// ---------------- 统一入口 ----------------

/**
 * @param {Buffer} buffer 文件内容
 * @param {string} ext 小写扩展名，如 '.docx'
 * @param {number} limit 最大字符数
 * @returns {string} 提取到的纯文本（失败返回空串）
 */
function extract(buffer, ext, limit) {
  const kind = OFFICE_EXT[ext];
  if (!kind) return '';
  try {
    if (kind === 'docx') return docxToText(buffer, limit);
    if (kind === 'xlsx') return xlsxToText(buffer, limit);
    if (kind === 'pptx') return pptxToText(buffer, limit);
  } catch (err) {
    console.error('[office] 解析失败 ' + ext + ':', err.message);
    return '';
  }
  return '';
}

module.exports = { extract, openZip, OFFICE_EXT, OFFICE_MIME, decodeEntities };
