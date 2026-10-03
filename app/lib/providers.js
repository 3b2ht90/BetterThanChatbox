'use strict';

const fs = require('fs');

const localfs = require('./localfs');

const DEFAULT_BASE = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
};

const DEFAULT_MODEL = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-sonnet-latest',
  gemini: 'gemini-2.0-flash',
};

function humanSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function trimBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function openaiEndpoint(base) {
  const b = trimBase(base) || DEFAULT_BASE.openai;
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v\d+(beta)?$/.test(b)) return b + '/chat/completions';
  return b + '/v1/chat/completions';
}

function openaiModelsEndpoint(base) {
  const b = trimBase(base) || DEFAULT_BASE.openai;
  if (/\/models$/.test(b)) return b;
  if (/\/v\d+(beta)?$/.test(b)) return b + '/models';
  if (/\/chat\/completions$/.test(b)) return b.replace(/\/chat\/completions$/, '/models');
  return b + '/v1/models';
}

function anthropicEndpoint(base) {
  const b = trimBase(base) || DEFAULT_BASE.anthropic;
  if (/\/messages$/.test(b)) return b;
  if (/\/v\d+$/.test(b)) return b + '/messages';
  return b + '/v1/messages';
}

function anthropicModelsEndpoint(base) {
  const b = trimBase(base) || DEFAULT_BASE.anthropic;
  if (/\/models$/.test(b)) return b;
  if (/\/v\d+$/.test(b)) return b + '/models';
  if (/\/messages$/.test(b)) return b.replace(/\/messages$/, '/models');
  return b + '/v1/models';
}

function geminiEndpoint(base, model, stream) {
  const b = trimBase(base) || DEFAULT_BASE.gemini;
  const m = String(model || '').replace(/^models\//, '');
  const method = stream ? 'streamGenerateContent' : 'generateContent';
  const suffix = stream ? '?alt=sse' : '';
  if (/\/v\d+beta$/.test(b)) return `${b}/models/${encodeURIComponent(m)}:${method}${suffix}`;
  return `${b}/v1beta/models/${encodeURIComponent(m)}:${method}${suffix}`;
}

function geminiModelsEndpoint(base) {
  const b = trimBase(base) || DEFAULT_BASE.gemini;
  if (/\/v\d+beta$/.test(b)) return b + '/models';
  return b + '/v1beta/models';
}

function apiKeyOf(conn) {
  return String((conn && conn.apiKey) || '').trim();
}

function effectiveModel(conn, modelOverride) {
  return String(modelOverride || (conn && conn.model) || '').trim() || DEFAULT_MODEL[(conn && conn.type) || 'openai'];
}

// ---------- 消息转换 ----------

function attachmentsAsText(attachments) {
  let out = '';
  for (const att of attachments || []) {
    if (!att) continue;
    if (att.kind === 'text') {
      if (att.text) {
        out += `\n\n----- 附件：${att.name} -----\n${att.text}\n----- 附件结束 -----`;
      } else {
        out += `\n\n[附件：${att.name}（读取失败，内容为空）]`;
      }
    } else if (att.kind === 'pdf') {
      out += att.text
        ? `\n\n----- 附件（PDF）：${att.name} -----\n${att.text}\n----- 附件结束 -----`
        : `\n\n[附件：${att.name}（PDF 中没有可提取的文字，可能是扫描件或图片型 PDF）]`;
    } else if (att.kind === 'office') {
      const label = ({ '.docx': 'Word 文档', '.xlsx': 'Excel 表格', '.pptx': 'PPT' })[att.ext] || 'Office 文档';
      out += att.text
        ? `\n\n----- 附件（${label}）：${att.name} -----\n${att.text}\n----- 附件结束 -----`
        : `\n\n[附件：${att.name}（${label}中没有提取到文字，可能是空文档或纯图片内容）]`;
    } else if (att.kind === 'folder') {
      if (att.missing) {
        // 导入的对话：文件夹在别的电脑上，本机读不了
        out += `\n\n[文件夹：${att.name}（原路径 ${att.path || '未知'} 不在本机，只有这条记录）]`;
        continue;
      }
      // 文件夹正文不存进 data.json，发请求时现读：既能保证内容最新，也不会把存档撑大
      let block;
      try {
        block = localfs.readFolderText(att.path).text;
      } catch (err) {
        block = `[这个文件夹现在读不了：${att.path}（${err.message}）]`;
      }
      out += `\n\n----- 文件夹：${att.path} -----\n${block}\n----- 文件夹结束 -----`;
    } else if (att.kind === 'other') {
      out += att.missing
        ? `\n\n[附件：${att.name}（原文件不在本机，只有文件名）]`
        : `\n\n[附件：${att.name}（${humanSize(att.size)}，该格式无法解析为文本，仅提供文件名）]`;
    }
  }
  return out;
}

function imageData(att) {
  const buf = fs.readFileSync(att.path);
  return { base64: buf.toString('base64'), mime: att.mime || 'image/png' };
}

function buildOpenAIMessages(messages, systemPrompt) {
  const out = [];
  const sys = String(systemPrompt || '').trim();
  if (sys) out.push({ role: 'system', content: sys });
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const text = String(m.content || '') + attachmentsAsText(m.attachments);
    const parts = [];
    if (text.trim()) parts.push({ type: 'text', text });
    if (role === 'user') {
      for (const att of m.attachments || []) {
        if (att && att.kind === 'image' && att.path && fs.existsSync(att.path)) {
          const { base64, mime } = imageData(att);
          parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } });
        }
      }
    }
    if (!parts.length) continue;
    if (parts.length === 1 && parts[0].type === 'text') out.push({ role, content: parts[0].text });
    else out.push({ role, content: parts });
  }
  return out;
}

function buildAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks = [];
    const text = String(m.content || '') + attachmentsAsText(m.attachments);
    if (text.trim()) blocks.push({ type: 'text', text });
    if (role === 'user') {
      for (const att of m.attachments || []) {
        if (att && att.kind === 'image' && att.path && fs.existsSync(att.path)) {
          const { base64, mime } = imageData(att);
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime) ? mime : 'image/png', data: base64 },
          });
        }
      }
    }
    if (!blocks.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  }
  // Anthropic 要求首条必须是 user
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function buildGeminiContents(messages) {
  const out = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    const text = String(m.content || '') + attachmentsAsText(m.attachments);
    if (text.trim()) parts.push({ text });
    if (role === 'user') {
      for (const att of m.attachments || []) {
        if (att && att.kind === 'image' && att.path && fs.existsSync(att.path)) {
          const { base64, mime } = imageData(att);
          parts.push({ inline_data: { mime_type: mime, data: base64 } });
        }
      }
    }
    if (!parts.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// ---------- SSE ----------

async function* sseEvents(body) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line) yield line;
    }
    if (buf.length > 4 * 1024 * 1024) buf = buf.slice(-1024);
  }
  buf += decoder.decode();
  if (buf.trim()) yield buf.trim();
}

async function errorFromResponse(res) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  let msg = '';
  try {
    const json = JSON.parse(text);
    msg = (json.error && (json.error.message || json.error.status)) || json.message || '';
  } catch {
    msg = text;
  }
  msg = String(msg || '').trim().slice(0, 600) || `HTTP ${res.status}`;
  const e = new Error(`请求失败 (HTTP ${res.status})：${msg}`);
  e.status = res.status;
  return e;
}

function friendlyFetchError(err) {
  if (err && err.name === 'AbortError') return new Error('已停止');
  // undici 会把真实原因藏在 cause 里（比如 ECONNREFUSED / ENOTFOUND）
  const parts = [String((err && err.message) || err)];
  let cause = err && err.cause;
  for (let depth = 0; cause && depth < 3; depth++) {
    parts.push(String(cause.code || '') + ' ' + String(cause.message || ''));
    if (Array.isArray(cause.errors)) {
      for (const sub of cause.errors) parts.push(String(sub.code || '') + ' ' + String(sub.message || ''));
    }
    cause = cause.cause;
  }
  const msg = parts.join(' | ');
  if (/AbortError/.test(msg)) return new Error('已停止');
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(msg)) return new Error('网络错误：无法解析接口域名，请检查 Base URL 与网络连接。');
  if (/ECONNREFUSED/.test(msg)) return new Error('连接被拒绝：接口地址或端口不正确，服务没有在运行。');
  if (/ECONNRESET|socket hang up/.test(msg)) return new Error('连接被重置：接口中断了连接，请稍后重试。');
  if (/CERT|SSL|TLS|self.signed/.test(msg)) return new Error('HTTPS 证书校验失败：请检查接口地址或代理设置。');
  if (/ETIMEDOUT|timeout/i.test(msg)) return new Error('请求超时：接口长时间没有响应。');
  if (/fetch failed/i.test(msg)) return new Error('网络请求失败：请检查 Base URL、网络或代理设置。');
  return err instanceof Error ? err : new Error(msg);
}

/**
 * 统一的流式对话入口。
 * 返回 { text, reasoning, thinkingSkipped }。
 *
 * opts.thinking = { enabled, budgetTokens }
 *   是否主动向接口索要思考过程：
 *   - Anthropic 必须显式开启（thinking 参数），否则一个字都不会返回
 *   - Gemini 需要 includeThoughts，否则只给答案不给思考摘要
 *   - OpenAI 兼容的推理模型（DeepSeek-R1 等）默认就会返回，不用额外参数
 *   如果某个模型不支持这些参数，会自动去掉参数重试一次（见下面的 fallback）。
 */
async function streamChat(opts) {
  const { connection, model, systemPrompt, temperature, messages, signal, onDelta, onReasoning } = opts;
  const type = (connection && connection.type) || 'openai';
  const mdl = effectiveModel(connection, model);
  const wantThinking = !!(opts.thinking && opts.thinking.enabled);

  // 把请求体拼装抽成函数：不支持思考参数时要能原样重拼一次（去掉思考字段）
  const buildRequest = (withThinking) => {
    let url;
    let headers;
    let body;

    if (type === 'anthropic') {
      url = anthropicEndpoint(connection.baseUrl);
      headers = {
        'content-type': 'application/json',
        'x-api-key': apiKeyOf(connection),
        'anthropic-version': '2023-06-01',
      };
      const maxTokens = 8192;
      body = {
        model: mdl,
        max_tokens: maxTokens,
        stream: true,
        messages: buildAnthropicMessages(messages),
      };
      if (String(systemPrompt || '').trim()) body.system = String(systemPrompt).trim();
      if (withThinking) {
        // budget 必须小于 max_tokens，留一半给正式回答
        body.thinking = { type: 'enabled', budget_tokens: Math.max(1024, Math.floor(maxTokens / 2)) };
        // 接口要求：开了 thinking 就不能自定义 temperature（只能 1 或不传）
      } else if (typeof temperature === 'number') {
        body.temperature = temperature;
      }
    } else if (type === 'gemini') {
      url = geminiEndpoint(connection.baseUrl, mdl, true);
      headers = { 'content-type': 'application/json', 'x-goog-api-key': apiKeyOf(connection) };
      const gen = {};
      if (typeof temperature === 'number') gen.temperature = temperature;
      if (withThinking) gen.thinkingConfig = { includeThoughts: true };
      body = { contents: buildGeminiContents(messages) };
      if (String(systemPrompt || '').trim()) body.system_instruction = { parts: [{ text: String(systemPrompt).trim() }] };
      if (Object.keys(gen).length) body.generationConfig = gen;
    } else {
      url = openaiEndpoint(connection.baseUrl);
      headers = { 'content-type': 'application/json' };
      if (apiKeyOf(connection)) headers.authorization = `Bearer ${apiKeyOf(connection)}`;
      body = { model: mdl, messages: buildOpenAIMessages(messages, systemPrompt), stream: true };
      // o 系列 / gpt-5 系列不接受 temperature
      const noTemp = /^(o\d|gpt-5)/i.test(mdl);
      if (typeof temperature === 'number' && !noTemp) body.temperature = temperature;
      // OpenRouter 要显式打开才会带上 reasoning 字段；其它中转站不认这个参数，所以只对它发
      if (withThinking && /openrouter/i.test(String(connection.baseUrl || ''))) {
        body.reasoning = { enabled: true };
      }
    }
    return { url, headers, body };
  };

  let req = buildRequest(wantThinking);
  const outgoing = type === 'gemini' ? req.body.contents : req.body.messages;
  if (!Array.isArray(outgoing) || outgoing.length === 0) {
    throw new Error('没有可发送的消息内容');
  }

  const doFetch = async (r) => {
    try {
      return await fetch(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify(r.body), signal });
    } catch (err) {
      throw friendlyFetchError(err);
    }
  };

  let thinkingSkipped = false;
  let res = await doFetch(req);
  if (!res.ok) {
    const firstError = await errorFromResponse(res);
    // 模型/接口不认识思考参数时，去掉它重试一次 —— 不能让"想显示思考"反而把对话弄挂
    if (wantThinking && /thinking|thought|reasoning/i.test(String(firstError.message || ''))) {
      req = buildRequest(false);
      res = await doFetch(req);
      thinkingSkipped = true;
      if (!res.ok) throw await errorFromResponse(res);
    } else {
      throw firstError;
    }
  }
  if (!res.body) throw new Error('接口没有返回流式内容');

  let text = '';
  let reasoning = '';

  for await (const line of sseEvents(res.body)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    if (json.error) {
      throw new Error((json.error && json.error.message) || '接口返回错误');
    }

    if (type === 'anthropic') {
      if (json.type === 'content_block_delta') {
        const d = json.delta || {};
        if (d.type === 'text_delta' && d.text) {
          text += d.text;
          if (onDelta) onDelta(d.text);
        } else if (d.type === 'thinking_delta' && d.thinking) {
          reasoning += d.thinking;
          if (onReasoning) onReasoning(d.thinking);
        }
      } else if (json.type === 'error') {
        throw new Error((json.error && json.error.message) || '接口返回错误');
      }
    } else if (type === 'gemini') {
      const cand = (json.candidates || [])[0];
      const parts = (cand && cand.content && cand.content.parts) || [];
      for (const p of parts) {
        if (!p.text) continue;
        // thought: true 的片段是思考过程，不能混进正式回答
        if (p.thought === true) {
          reasoning += p.text;
          if (onReasoning) onReasoning(p.text);
        } else {
          text += p.text;
          if (onDelta) onDelta(p.text);
        }
      }
      if (json.promptFeedback && json.promptFeedback.blockReason) {
        throw new Error('内容被 Gemini 安全策略拦截：' + json.promptFeedback.blockReason);
      }
    } else {
      const choice = (json.choices || [])[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content) {
        text += delta.content;
        if (onDelta) onDelta(delta.content);
      }
      // 各个接口对"思考过程"的字段名不一样：
      //   DeepSeek / 官方兼容格式 → reasoning_content
      //   OpenRouter 等           → reasoning
      //   少数中转站              → thinking
      const think = delta.reasoning_content || delta.reasoning || delta.thinking;
      if (think) {
        reasoning += think;
        if (onReasoning) onReasoning(think);
      }
      if (choice.finish_reason === 'content_filter') {
        throw new Error('内容被接口的安全策略拦截。');
      }
    }
  }

  return { text, reasoning, thinkingSkipped };
}

// ---------- 模型列表 ----------

async function listModels(connection) {
  const type = (connection && connection.type) || 'openai';
  let url;
  let headers;
  if (type === 'anthropic') {
    url = anthropicModelsEndpoint(connection.baseUrl);
    headers = { 'x-api-key': apiKeyOf(connection), 'anthropic-version': '2023-06-01' };
  } else if (type === 'gemini') {
    url = geminiModelsEndpoint(connection.baseUrl);
    headers = { 'x-goog-api-key': apiKeyOf(connection) };
  } else {
    url = openaiModelsEndpoint(connection.baseUrl);
    headers = {};
    if (apiKeyOf(connection)) headers.authorization = `Bearer ${apiKeyOf(connection)}`;
  }
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    throw friendlyFetchError(err);
  }
  if (!res.ok) throw await errorFromResponse(res);
  const json = await res.json();
  let ids = [];
  if (Array.isArray(json.data)) ids = json.data.map((m) => m.id || m.name);
  else if (Array.isArray(json.models)) ids = json.models.map((m) => String(m.name || '').replace(/^models\//, ''));
  return ids.filter(Boolean).sort();
}

module.exports = {
  streamChat,
  listModels,
  DEFAULT_BASE,
  DEFAULT_MODEL,
  effectiveModel,
  openaiEndpoint,
  anthropicEndpoint,
  geminiEndpoint,
};
