'use strict';

// 上下文用量估算 + 压缩。
//
// 为什么不引入真正的 tokenizer：tiktoken 只对应 OpenAI，Claude / Gemini 各有各的分词，
// 而且要跟着模型版本换。这里用分语种的字符启发式估个近似值（显示成「约」），
// 好处是零依赖、三家协议都能用、也不会因为接口更新而失效。
// 误差通常在 ±15% 以内，对「还剩多少额度、该不该压缩」这个用途足够了。

/** 粗略估算一段文本的 token 数 */
function estimateTokens(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    // 中日韩文字 + 全角标点：大约 1 字 ≈ 1 token
    if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) ||
        (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) {
      cjk++;
    } else {
      other++;
    }
  }
  // 其余（英文/代码/数字）：约 4 字符 ≈ 1 token
  return Math.ceil(cjk + other / 4);
}

// 常见模型的上下文窗口（tokens）。认不出来就用 DEFAULT_LIMIT，
// 并且随时可以在接口设置里手填覆盖 —— 中转站上的模型五花八门，表格不可能全。
const LIMITS = [
  [/deepseek/i, 65536],
  [/(^|[^a-z])o\d|gpt-5/i, 200000],
  [/gpt-4\.1/i, 1048576],
  [/gpt-4o|gpt-4-turbo|gpt-4-0125|gpt-4-1106/i, 128000],
  [/gpt-4/i, 8192],
  [/gpt-3\.5/i, 16385],
  [/claude/i, 200000],
  [/gemini/i, 1048576],
  [/qwen|通义/i, 131072],
  [/glm|chatglm|智谱/i, 131072],
  [/kimi|moonshot/i, 131072],
  [/grok/i, 131072],
  [/llama|mistral|mixtral|yi-|command-r/i, 32768],
];
const DEFAULT_LIMIT = 128000;

/** 这个模型能塞多少 token；override 是用户在接口设置里手填的值（0 = 用内置表） */
function contextLimit(model, override) {
  const o = Math.floor(Number(override) || 0);
  if (o > 0) return o;
  const m = String(model || '');
  for (const [re, n] of LIMITS) if (re.test(m)) return n;
  return DEFAULT_LIMIT;
}

/**
 * 算一次请求会占用多少上下文。
 * 口径与真正发出去的请求保持一致：系统提示词 + 附件正文 + 每条消息的正文与思考过程。
 * （思考过程只有开思考的接口才会回传，但它会占上下文，所以按实际情况算进去）
 */
function contextUsage({ systemPrompt, messages, model, limitOverride } = {}) {
  let tokens = estimateTokens(systemPrompt);
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    if (!m) continue;
    tokens += estimateTokens(m.content);
    if (m.reasoning) tokens += estimateTokens(m.reasoning);
    for (const att of m.attachments || []) {
      if (!att) continue;
      if (att.text) tokens += estimateTokens(att.text);
      else if (att.kind === 'folder') {
        // 文件夹正文是发请求时现读的，这里按文件大小粗估（正文一般比文件小）
        tokens += Math.ceil((Number(att.totalBytes) || 0) / 8);
      } else if (att.kind === 'image') {
        tokens += 800; // 图片按视觉输入的常见开销粗估
      }
    }
  }
  const limit = contextLimit(model, limitOverride);
  const percent = limit > 0 ? Math.min(100, Math.round((tokens / limit) * 1000) / 10) : 0;
  return { tokens, limit, percent, messages: list.length };
}

/** 用多大的窗口算「该压缩了」：超过这个比例就给提示 */
const WARN_PERCENT = 75;
/** 压缩时默认保留最近多少条消息不动（越近的对话越重要） */
const DEFAULT_KEEP_RECENT = 6;

function usageLevel(percent) {
  if (percent >= WARN_PERCENT) return 'high';
  if (percent >= 50) return 'mid';
  return 'low';
}

/**
 * 选出一批「该被压缩掉」的消息：保留最近 keepRecent 条不动，
 * 其余里挑出还没被压缩过的那些。返回的这批会被摘要替换掉。
 */
function pickCompressible(messages, keepRecent) {
  const list = Array.isArray(messages) ? messages : [];
  const keep = Math.max(0, Math.floor(keepRecent));
  const head = keep > 0 ? list.slice(0, Math.max(0, list.length - keep)) : list.slice();
  const picked = head.filter((m) => m && !m.compressed && !m.isSummary && !m.error);
  return { picked, kept: list.slice(Math.max(0, list.length - keep)) };
}

/** 把要压缩的消息拼成给模型看的对话记录 */
function transcriptOf(messages) {
  const lines = [];
  for (const m of messages || []) {
    if (!m) continue;
    const who = m.role === 'assistant' ? 'AI' : '用户';
    const body = String(m.content || '').trim();
    if (!body) continue;
    lines.push('【' + who + '】' + body);
  }
  return lines.join('\n\n');
}

/** 生成摘要消息的正文（会被当成一条用户消息放进上下文） */
function summaryMessageText(summary, count) {
  return '【上下文摘要】以下是之前 ' + count + ' 条对话的要点（原文仍保留在对话里，可展开查看）：\n\n' +
    String(summary || '').trim();
}

module.exports = {
  estimateTokens,
  contextLimit,
  contextUsage,
  usageOf: contextUsage, // 别名，主进程里读起来顺一点
  usageLevel,
  pickCompressible,
  transcriptOf,
  summaryMessageText,
  WARN_PERCENT,
  DEFAULT_KEEP_RECENT,
  DEFAULT_LIMIT,
  LIMITS,
};
