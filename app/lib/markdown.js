'use strict';

const { marked } = require('marked');
const hljs = require('highlight.js');

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const renderer = new marked.Renderer();

renderer.code = function (codeOrToken, infostring) {
  const isToken = codeOrToken && typeof codeOrToken === 'object';
  const code = String((isToken ? codeOrToken.text : codeOrToken) || '');
  const info = String((isToken ? codeOrToken.lang : infostring) || '').trim();
  const lang = info.split(/\s+/)[0].toLowerCase();
  let highlighted;
  try {
    if (lang && hljs.getLanguage(lang)) {
      highlighted = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } else {
      highlighted = hljs.highlightAuto(code).value;
    }
  } catch {
    highlighted = escapeHtml(code);
  }
  return (
    '<div class="code-block">' +
    '<div class="code-head"><span class="code-lang">' + escapeHtml(lang || 'text') + '</span>' +
    '<button type="button" class="code-copy" data-copy>复制</button></div>' +
    '<pre><code class="hljs">' + highlighted + '</code></pre>' +
    '</div>'
  );
};

renderer.link = function (hrefOrToken, title, text) {
  const isToken = hrefOrToken && typeof hrefOrToken === 'object';
  const href = String((isToken ? hrefOrToken.href : hrefOrToken) || '');
  const label = isToken ? hrefOrToken.text : text;
  const t = isToken ? hrefOrToken.title : title;
  if (!/^(https?:|mailto:)/i.test(href)) return label || '';
  return (
    '<a href="' + escapeHtml(href) + '"' + (t ? ' title="' + escapeHtml(t) + '"' : '') +
    ' target="_blank" rel="noreferrer noopener">' + (label || escapeHtml(href)) + '</a>'
  );
};

renderer.image = function (hrefOrToken, title, text) {
  const isToken = hrefOrToken && typeof hrefOrToken === 'object';
  const href = String((isToken ? hrefOrToken.href : hrefOrToken) || '');
  const alt = String((isToken ? hrefOrToken.text : text) || '');
  const t = isToken ? hrefOrToken.title : title;
  if (!/^(https?:|data:image\/)/i.test(href)) return escapeHtml(alt);
  return (
    '<img class="md-img" src="' + escapeHtml(href) + '" alt="' + escapeHtml(alt) + '"' +
    (t ? ' title="' + escapeHtml(t) + '"' : '') + ' loading="lazy">'
  );
};

marked.setOptions({
  gfm: true,
  breaks: true,
  renderer,
});

/** 兜底清洗：即使 CSP 失效，也去掉可执行内容 */
function sanitize(html) {
  return String(html)
    .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<\s*\/?\s*(script|iframe|object|embed|link|meta|base|form)[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*(javascript|vbscript|data:text\/html)[^"']*\2/gi, '$1="#"');
}

function render(text) {
  const src = String(text == null ? '' : text);
  if (!src.trim()) return '';
  try {
    return sanitize(marked.parse(src));
  } catch (err) {
    console.error('[markdown]', err);
    return '<p>' + escapeHtml(src) + '</p>';
  }
}

module.exports = { render, escapeHtml };
