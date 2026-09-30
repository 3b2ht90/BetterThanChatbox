'use strict';

// 读本地文档 / 文件夹。
//
// 设计要点：
//   1. 只有「用户消息里明确写出的路径」才会被读取 —— 应用自己去认路径，
//      不给模型工具权限，所以模型读不到用户没指定的文件（防提示注入）。
//   2. 消息里只存路径和文件清单（元数据），正文在真正发请求时现读现拼。
//      这样 data.json 不会被几百 KB 的正文撑大，内容也永远是最新的。
//   3. 一切都有上限：文件数、目录深度、单文件大小、总字符数；扫描时会跳过
//      node_modules/.git 这类目录，并且拒绝盘符根目录和系统目录。

const fs = require('fs');
const os = require('os');
const path = require('path');

const attachments = require('./attachments');

const LIMITS = {
  maxFiles: 40,           // 最多读多少个文件
  maxDepth: 3,            // 往下钻几层
  maxFileBytes: 5 * 1024 * 1024,  // 单个文件超过 5 MB 不读
  maxTotalChars: 200000,  // 拼给 AI 的正文总量上限
  maxPerFileChars: 60000, // 单个文件正文上限
};

// 明显是噪音的目录，直接跳过
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv',
  '.cache', '.idea', '.vscode', '$RECYCLE.BIN', 'System Volume Information',
  '.next', '.nuxt', '.gradle', '.pytest_cache', '.mypy_cache',
]);

function humanSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

/** 看起来像不像本机路径（排除 http:// 之类的 URL） */
function looksLikePath(s) {
  const t = String(s || '').trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(t)) return false; // 带协议的 URL
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/.test(t);
}

/**
 * 从一段文本里挑出「可能是本机路径」的候选串。
 * 纯函数，不碰文件系统，方便单测。
 */
function extractCandidatePaths(text) {
  const src = String(text || '');
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const t = String(raw || '').trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  // 1) 引号包起来的（能带空格，最可靠）
  const quoted = /["'“”‘’「」【】]([^"'“”‘’「」【】\n]{3,300})["'“”‘’「」【】]/g;
  const quotedRanges = [];
  let m;
  while ((m = quoted.exec(src)) !== null) {
    quotedRanges.push([m.index, m.index + m[0].length]);
    if (looksLikePath(m[1])) push(m[1]);
  }
  const inQuoted = (i) => quotedRanges.some(([a, b]) => i > a && i < b);

  // 2) 裸路径：行首或分隔符之后跟上盘符 / UNC。引号里的已经处理过，跳过。
  //    路径本身可能带空格，所以不能简单地"从起点吃到行尾" —— 那样
  //    「对比 D:\a 和 E:\b」会被当成一个候选串，第二个路径就丢了。
  //    做法：先找出每一个「路径起点」，每个候选只取到下一个起点/行尾为止。
  const starts = [];
  const startRe = /(?:[A-Za-z]:[\\/]|\\\\[^\\/\s])/g;
  while ((m = startRe.exec(src)) !== null) {
    if (inQuoted(m.index)) continue;
    const before = m.index === 0 ? '' : src[m.index - 1];
    if (m.index > 0 && !/[\s(（[【,，;；:：、>]/.test(before)) continue;
    starts.push(m.index);
  }
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const lineEnd = src.indexOf('\n', from);
    const nextStart = i + 1 < starts.length ? starts[i + 1] : -1;
    let to = src.length;
    if (nextStart > 0) to = nextStart;
    if (lineEnd >= 0 && lineEnd < to) to = lineEnd;
    const raw = src.slice(from, to)
      .replace(/["'“”‘’「」【】]+$/, '')
      .replace(/[。，,;；、!！?？)\]】》>]+$/, '')
      .trim();
    if (raw.length >= 3 && looksLikePath(raw)) push(raw);
  }

  return out;
}

/**
 * 把候选串收敛成「磁盘上真实存在的最长前缀」。
 * 例："D:\项目A 里的文档" → "D:\项目A"（因为有空格，只能靠"往短了试"来定边界）
 *
 * 关键点：每次从**最靠右**的边界切一刀，而边界既可能是分隔符，也可能是空白 ——
 * 只按分隔符切的话，"D:\项目A 里的文档" 会先被切成 "D:\"（唯一的分隔符在盘符后面），
 * 结果要么切没了要么退到上一级目录。
 *
 * @param {string} candidate
 * @param {(p:string)=>boolean} exists 注入存在性判断，便于单测
 */
function longestExistingPath(candidate, exists) {
  let s = String(candidate || '').trim().replace(/^["'“”‘’「」【】]+|["'“”‘’「」【】]+$/g, '');
  s = s.replace(/[。，,;；、!！?？)\]】》>]+$/, '');
  if (!s) return null;
  for (let guard = 0; guard < 200; guard++) {
    if (s.length < 3) return null;
    if (exists(s)) return s;
    const cutSpace = Math.max(s.lastIndexOf(' '), s.lastIndexOf('\t'));
    const cutSep = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    const cut = Math.max(cutSpace, cutSep);
    if (cut < 2) return null; // 退到 "D:\" 就不必再切了（盘符根目录后面会被拦）
    s = s.slice(0, cut);
  }
  return null;
}

/** 危险路径：盘符根目录、系统目录 —— 不扫，避免把整个 C 盘读进来 */
function riskyReason(p) {
  const resolved = path.resolve(p);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) return '盘符根目录（如 C:\\、D:\\）不扫描';
  const sysRoot = (process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows');
  const low = resolved.toLowerCase();
  const blocked = [sysRoot, 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'];
  for (const b of blocked) {
    if (b && (low === b.toLowerCase() || low.startsWith(b.toLowerCase() + '\\'))) {
      return '系统目录不扫描';
    }
  }
  return null;
}

/** 扫目录，只列清单（不读正文） */
function listFolder(root, opts = {}) {
  const limits = { ...LIMITS, ...opts };
  const files = [];      // 会被读取的文件
  const skipped = [];    // 列出了名字但不读的条目
  let truncated = false;

  const walk = (dir, depth, relBase) => {
    if (files.length >= limits.maxFiles) { truncated = true; return; }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ rel: relBase || '.', reason: '目录读不了：' + err.code });
      return;
    }
    // 浅的先来、同层按名字排，保证结果稳定（超额时优先保留顶层文件）
    entries.sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name));

    for (const ent of entries) {
      if (files.length >= limits.maxFiles) { truncated = true; return; }
      const full = path.join(dir, ent.name);
      const rel = relBase ? relBase + '/' + ent.name : ent.name;

      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) {
          skipped.push({ rel: rel + '/', reason: '已跳过的目录' });
        } else if (depth + 1 > limits.maxDepth) {
          skipped.push({ rel: rel + '/', reason: '超出目录深度上限' });
        } else {
          walk(full, depth + 1, rel);
        }
        continue;
      }
      if (!ent.isFile()) { skipped.push({ rel, reason: '不是普通文件' }); continue; }

      let stat;
      try { stat = fs.statSync(full); } catch { skipped.push({ rel, reason: '读取属性失败' }); continue; }

      const info = attachments.classify(ent.name, '');
      if (info.kind === 'image') { skipped.push({ rel, reason: '图片（不读正文）', size: stat.size }); continue; }
      if (stat.size > limits.maxFileBytes) {
        skipped.push({ rel, reason: '文件过大（>' + humanSize(limits.maxFileBytes) + '）', size: stat.size });
        continue;
      }
      files.push({ rel, name: ent.name, full, size: stat.size, kind: info.kind, ext: info.ext });
    }
  };

  walk(path.resolve(root), 0, '');
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  return {
    root: path.resolve(root),
    name: path.basename(path.resolve(root)) || path.resolve(root),
    files,
    skipped: skipped.slice(0, 40),
    skippedCount: skipped.length,
    truncated,
    totalBytes,
  };
}

/** 把清单变成要发给 AI 的正文（真正读文件在这里发生） */
function readFolderText(root, opts = {}) {
  const limits = { ...LIMITS, ...opts };
  const listed = listFolder(root, limits);
  const parts = [];
  const failed = []; // 提不出正文的（单独记，别和 listFolder 的 skipped 混在一起重复计数）
  let totalChars = 0;
  let readCount = 0;
  const readOk = [];

  for (const f of listed.files) {
    if (totalChars >= limits.maxTotalChars) break;
    let text = '';
    try {
      const buf = fs.readFileSync(f.full);
      const info = attachments.classify(f.name, '');
      text = attachments.extractText(buf, info);
    } catch (err) {
      failed.push({ rel: f.rel, reason: '读取失败：' + err.code, size: f.size });
      continue;
    }
    if (!text || !text.trim()) {
      failed.push({ rel: f.rel, reason: '提取不到文字', size: f.size });
      continue;
    }
    const room = Math.min(limits.maxPerFileChars, limits.maxTotalChars - totalChars);
    const body = text.slice(0, room);
    const cut = text.length > body.length;
    totalChars += body.length;
    readCount++;
    readOk.push({ rel: f.rel, size: f.size, kind: f.kind, chars: body.length, truncated: cut });
    parts.push(
      `===== ${readCount}/${listed.files.length}  ${f.rel}（${humanSize(f.size)}）=====\n` +
      body + (cut ? '\n…（该文件内容过长，已截断）' : '')
    );
  }

  const notProvided = listed.skipped.concat(failed);
  const scannedTotal = listed.files.length + listed.skipped.length; // 扫到的条目总数（不含重复计数）

  const head = [];
  head.push(`[文件夹] ${listed.root}`);
  head.push(`共扫描到 ${scannedTotal} 个条目，` +
    `下面提供了其中 ${readCount} 个文件的正文（总 ${totalChars} 字符）。`);
  if (notProvided.length) {
    head.push('未提供正文的条目（只列名字，供你判断目录里还有什么）：');
    for (const s of notProvided.slice(0, 25)) {
      head.push(`  - ${s.rel}${s.size ? '（' + humanSize(s.size) + '）' : ''}　${s.reason}`);
    }
    if (notProvided.length > 25) head.push(`  - …还有 ${notProvided.length - 25} 个`);
  }
  if (listed.truncated) head.push(`（文件数超过上限 ${limits.maxFiles}，只处理了前 ${listed.files.length} 个）`);
  if (totalChars >= limits.maxTotalChars) head.push(`（正文总量达到上限 ${limits.maxTotalChars} 字符，后面的文件没有读）`);

  return {
    text: head.join('\n') + (parts.length ? '\n\n' + parts.join('\n\n') : '\n\n（这个文件夹里没有能读取正文的文件）'),
    stats: {
      root: listed.root,
      filesScanned: scannedTotal,
      filesRead: readCount,
      skipped: notProvided.length,
      totalChars,
      truncated: listed.truncated || totalChars >= limits.maxTotalChars,
      readOk,
    },
  };
}

/** 描述一个「已确认存在」的路径，给界面和附件共用 */
function describePath(resolvedInput, limits = LIMITS) {
  const resolved = path.resolve(resolvedInput);
  const risky = riskyReason(resolved);
  let stat;
  try { stat = fs.statSync(resolved); } catch { return null; }

  if (stat.isDirectory()) {
    if (risky) {
      return { path: resolved, kind: 'blocked', name: path.basename(resolved), warning: risky };
    }
    const listed = listFolder(resolved, limits);
    return {
      path: resolved,
      kind: 'folder',
      name: listed.name,
      fileCount: listed.files.length,
      skippedCount: listed.skipped.length,
      totalBytes: listed.totalBytes,
      truncated: listed.truncated,
      files: listed.files.map((f) => ({ rel: f.rel, size: f.size, kind: f.kind })),
      skipped: listed.skipped.slice(0, 12),
    };
  }

  const info = attachments.classify(path.basename(resolved), '');
  if (info.kind === 'image') {
    return { path: resolved, kind: 'image', name: path.basename(resolved), size: stat.size, fileKind: 'image' };
  }
  if (stat.size > limits.maxFileBytes) {
    return {
      path: resolved, kind: 'blocked', name: path.basename(resolved),
      warning: '文件过大（>' + humanSize(limits.maxFileBytes) + '）',
    };
  }
  return {
    path: resolved,
    kind: 'file',
    name: path.basename(resolved),
    fileKind: info.kind,
    size: stat.size,
  };
}

/**
 * 探测文本里的路径，返回给界面用的元数据（不读正文，快）。
 * @returns {{items: Array<object>}}
 */
function probeText(text, opts = {}) {
  const limits = { ...LIMITS, ...opts };
  const candidates = extractCandidatePaths(text);
  const items = [];
  const seen = new Set();

  for (const raw of candidates) {
    const hit = longestExistingPath(raw, (p) => fs.existsSync(p));
    if (!hit) continue;
    const resolved = path.resolve(hit);
    if (seen.has(resolved.toLowerCase())) continue;
    seen.add(resolved.toLowerCase());
    const item = describePath(resolved, limits);
    if (item) items.push(item);
  }
  return { items };
}

/** 文件夹探测结果 → 消息附件元数据（正文不存，发请求时现读） */
function folderToAttachment(item) {
  return {
    id: require('crypto').randomUUID(),
    kind: 'folder',
    name: item.name,
    path: item.path,
    fileCount: item.fileCount,
    skippedCount: item.skippedCount,
    totalBytes: item.totalBytes,
    truncated: item.truncated,
    files: item.files,
    size: item.totalBytes,
    text: '',
    hasText: true,
  };
}

module.exports = {
  LIMITS,
  SKIP_DIRS,
  looksLikePath,
  extractCandidatePaths,
  longestExistingPath,
  riskyReason,
  describePath,
  listFolder,
  readFolderText,
  probeText,
  folderToAttachment,
  humanSize,
};
