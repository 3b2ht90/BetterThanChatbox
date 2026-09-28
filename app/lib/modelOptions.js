'use strict';

// 模型下拉列表的内容来源（纯函数，方便直接单测）。
//
// 一个接口「能用的模型名」有三个来源，按可信度排序：
//   1. 从接口拉取的列表（最准，存在 connection.models 里，可缓存复用）
//   2. 本机用过的（其它对话/接口里出现过，说明确实能用）
//   3. 官方常见模型（兜底建议：没填 Key、拉不到列表时也能一键选）

// 按接口类型 + Base URL 猜一组「大概率能用」的常用模型
const PRESETS = {
  openai: [
    { match: /deepseek/i, models: ['deepseek-chat', 'deepseek-reasoner'] },
    { match: /openrouter/i, models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash-001'] },
    { match: /siliconflow|硅基/i, models: ['Qwen/Qwen2.5-7B-Instruct', 'deepseek-ai/DeepSeek-V3'] },
    { match: /dashscope|aliyun/i, models: ['qwen-plus', 'qwen-turbo', 'qwen-max'] },
    { match: /moonshot/i, models: ['moonshot-v1-8k', 'moonshot-v1-32k'] },
    { match: /zhipu|bigmodel/i, models: ['glm-4-plus', 'glm-4-flash'] },
    { match: /localhost|127\.0\.0\.1|192\.168\./i, models: ['qwen2.5:7b', 'llama3.1:8b', 'deepseek-r1:7b'] },
    { match: /.*/, models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'] },
  ],
  anthropic: [{ match: /.*/, models: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-7-sonnet-latest'] }],
  gemini: [{ match: /.*/, models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro'] }],
};

function presetsFor(connection) {
  const type = (connection && connection.type) || 'openai';
  const base = String((connection && connection.baseUrl) || '');
  const list = PRESETS[type] || PRESETS.openai;
  for (const entry of list) {
    if (entry.match.test(base)) return entry.models.slice();
  }
  return [];
}

/** 收集本机用过的模型名（当前接口的优先） */
function usedModels(state, connection) {
  const seen = new Map(); // model -> 次数
  const bump = (m) => {
    const name = String(m || '').trim();
    if (!name) return;
    seen.set(name, (seen.get(name) || 0) + 1);
  };
  // 接口自己配置的模型
  for (const conn of state.connections || []) {
    if (conn.model && (!connection || conn.id === connection.id)) bump(conn.model);
  }
  // 各对话里选的模型
  for (const conv of state.conversations || []) {
    if (connection && conv.connectionId && conv.connectionId !== connection.id) continue;
    bump(conv.model);
  }
  return Array.from(seen.entries()).sort((a, b) => b[1] - a[1]).map(([m]) => m);
}

/**
 * 生成下拉列表的分组内容。
 * @param {object} state 整个 store 状态
 * @param {object} connection 当前接口
 * @param {string} currentModel 当前对话正在用的模型（可能为空 = 用接口默认）
 * @returns {{groups: Array<{label:string, models:string[]}>, fetchedAt:string|null, hasCache:boolean}}
 */
function suggestModels(state, connection, currentModel) {
  const fetched = (connection && Array.isArray(connection.models)) ? connection.models.slice() : [];
  const used = usedModels(state, connection);
  const presets = presetsFor(connection);

  const groups = [];
  const taken = new Set();

  const push = (label, models) => {
    const list = [];
    for (const m of models) {
      const name = String(m || '').trim();
      if (!name || taken.has(name)) continue;
      taken.add(name);
      list.push(name);
    }
    if (list.length) groups.push({ label, models: list });
  };

  // 当前正在用的模型单独放最上面，方便确认「现在用的是哪个」
  if (currentModel) push('当前使用', [currentModel]);
  push('来自接口', fetched);
  push('本机用过的', used);
  push('常用模型', presets);

  return {
    groups,
    fetchedAt: (connection && connection.modelsFetchedAt) || null,
    hasCache: fetched.length > 0,
  };
}

/** 把「拉到的模型列表」规范化：去空、去重、排序 */
function normalizeFetched(list) {
  const out = [];
  const seen = new Set();
  for (const item of list || []) {
    const name = String(item || '').trim().replace(/^models\//, '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

module.exports = { suggestModels, presetsFor, usedModels, normalizeFetched, PRESETS };
