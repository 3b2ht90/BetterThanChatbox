'use strict';

const path = require('path');
const zlib = require('zlib');
const { MAX_TEXT_CHARS } = require('./store');
const officedoc = require('./officedoc');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.yml', '.yaml',
  '.xml', '.html', '.htm', '.css', '.scss', '.less', '.js', '.jsx', '.ts', '.tsx', '.mjs',
  '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.php', '.swift', '.sql', '.sh', '.bash', '.ps1', '.bat', '.cmd', '.ini', '.toml', '.env',
  '.conf', '.vue', '.svelte', '.lua', '.pl', '.r', '.dart', '.gradle', '.properties',
]);

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

function mimeFor(ext, fallback) {
  if (IMAGE_MIME[ext]) return IMAGE_MIME[ext];
  return fallback || 'application/octet-stream';
}

function isTextLike(ext, mime) {
  if (TEXT_EXT.has(ext)) return true;
  if (!mime) return false;
  if (mime.startsWith('text/')) return true;
  return ['application/json', 'application/xml', 'application/javascript', 'application/x-yaml'].includes(mime);
}

/**
 * 极简 PDF 文本提取：解压流对象，抓取 BT/ET 内的 Tj / TJ 字符串。
 * 对文本型 PDF 有效，扫描件（图片型 PDF）会返回空。
 */
function extractPdfText(buffer) {
  const out = [];
  const startRe = /stream\r?\n/g;
  let m;
  while ((m = startRe.exec(buffer)) !== null) {
    const begin = m.index + m[0].length;
    const end = buffer.indexOf('endstream', begin);
    if (end < 0) continue;
    let chunk = buffer.slice(begin, end);
    // 去掉尾部换行
    if (chunk.length > 1 && chunk[chunk.length - 1] === 0x0a) chunk = chunk.slice(0, -1);
    if (chunk.length > 1 && chunk[chunk.length - 1] === 0x0d) chunk = chunk.slice(0, -1);
    let text = null;
    try {
      text = zlib.inflateSync(chunk).toString('latin1');
    } catch {
      try {
        text = zlib.inflateRawSync(chunk).toString('latin1');
      } catch {
        text = chunk.toString('latin1');
      }
    }
    if (text && /\bTj\b|\bTJ\b/.test(text)) out.push(text);
    if (out.join('').length > MAX_TEXT_CHARS * 2) break;
  }

  const pieces = [];
  for (const content of out) {
    const re = /\((?:\\\)|\\\(|[^()\\])*\)|<[0-9A-Fa-f\s]+>/g;
    let mm;
    let line = '';
    while ((mm = re.exec(content)) !== null) {
      const tok = mm[0];
      let str = '';
      if (tok.startsWith('<')) {
        const hex = tok.slice(1, -1).replace(/\s+/g, '');
        // 优先按 UTF-16BE 解析（中文 PDF 常用）
        if (hex.length % 4 === 0) {
          let utf16 = '';
          for (let i = 0; i < hex.length; i += 4) {
            const code = parseInt(hex.slice(i, i + 4), 16);
            utf16 += String.fromCharCode(code);
          }
          if (!/[\u0000-\u0008\u000e-\u001f]/.test(utf16)) str = utf16;
        }
        if (!str) {
          for (let i = 0; i < hex.length; i += 2) {
            const c = parseInt(hex.slice(i, i + 2), 16);
            if (c >= 32 && c < 127) str += String.fromCharCode(c);
          }
        }
      } else {
        str = tok
          .slice(1, -1)
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\\(/g, '(')
          .replace(/\\\)/g, ')')
          .replace(/\\\\/g, '\\');
      }
      line += str;
    }
    if (line.trim()) pieces.push(line.trim());
  }

  let text = pieces.join('\n').replace(/[ \t]{2,}/g, ' ').trim();
  return text.slice(0, MAX_TEXT_CHARS);
}

function classify(name, mime) {
  const ext = path.extname(name || '').toLowerCase();
  if (IMAGE_EXT.has(ext)) return { kind: 'image', ext, mime: mimeFor(ext, mime) };
  if (isTextLike(ext, mime)) return { kind: 'text', ext, mime: mimeFor(ext, mime) };
  if (ext === '.pdf') return { kind: 'pdf', ext, mime: 'application/pdf' };
  if (officedoc.OFFICE_EXT[ext]) return { kind: 'office', ext, mime: officedoc.OFFICE_MIME[ext] };
  return { kind: 'other', ext, mime: mimeFor(ext, mime) };
}

function extractText(buffer, info) {
  if (info.kind === 'text') {
    let text = buffer.toString('utf8');
    // 处理 UTF-16 BOM
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (/\u0000/.test(text.slice(0, 200))) {
      const alt = buffer.toString('utf16le');
      if (!/\u0000/.test(alt.slice(0, 200))) text = alt;
    }
    return text.slice(0, MAX_TEXT_CHARS);
  }
  if (info.kind === 'pdf') {
    try {
      return extractPdfText(buffer);
    } catch {
      return '';
    }
  }
  if (info.kind === 'office') {
    return officedoc.extract(buffer, info.ext, MAX_TEXT_CHARS);
  }
  return '';
}

module.exports = { classify, extractText, IMAGE_EXT, TEXT_EXT, mimeFor, OFFICE_EXT: officedoc.OFFICE_EXT };
