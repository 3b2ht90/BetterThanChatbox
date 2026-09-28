'use strict';

// 模型下拉选择器的端到端测试驱动。
// 由主进程 require 后调用，参数是 (win, app)。
//
// 做法：在驱动里起一个假的 OpenAI 兼容服务（/v1/models 返回一批模型名），
// 往应用里塞一个指向它的接口，然后真的去点顶栏的下拉按钮：
//   打开面板 → 列表里出现假服务返回的模型 → 点一个 → 对话的 model 真的变了。
//
// 用法见 scripts/run-model-e2e.mjs

const http = require('http');
const path = require('path');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SERVED_MODELS = [
  'zebra-model-7b',
  'alpha-model-70b',
  'deepseek-chat-来自假服务',
];

module.exports = async function modelPickerE2E(win, app) {
  const checks = [];
  const check = (name, pass, extra) => {
    checks.push({ name, pass: !!pass, extra: extra === undefined ? null : String(extra) });
    console.log((pass ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined && !pass ? '  → ' + extra : ''));
  };
  const js = (code) => win.webContents.executeJavaScript(code, true);

  // ---------- 假接口服务 ----------
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: SERVED_MODELS.map((id) => ({ id, object: 'model' })) }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  console.log('假接口服务：' + baseUrl);

  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  await sleep(1500);

  try {
    // ---------- 准备：一个指向假服务的接口 ----------
    const setup = await js(`(async () => {
      const s = await window.api.getState();
      // 清掉旧接口，避免干扰
      for (const c of s.connections) await window.api.deleteConnection(c.id);
      const conn = await window.api.addConnection({
        name: '假接口', type: 'openai', baseUrl: ${JSON.stringify(baseUrl)},
        apiKey: 'sk-fake', model: 'alpha-model-70b'
      });
      await window.api.setActiveConnection(conn.id);
      let conv = s.conversations[0];
      if (!conv) conv = await window.api.createConversation({ connectionId: conn.id });
      await window.api.updateConversation(conv.id, { connectionId: conn.id, model: '', title: '模型下拉测试' });
      return { connId: conn.id, convId: conv.id };
    })()`);
    check('准备了一个指向假接口的对话', !!(setup && setup.connId), JSON.stringify(setup));

    // 重新载入界面，让顶栏按新配置渲染
    win.webContents.reload();
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await sleep(1800);

    console.log('\n顶栏上的模型下拉');
    const initial = await js(`(() => {
      const btn = document.querySelector('#model-picker .mp-btn');
      return {
        hasBtn: !!btn,
        label: btn ? btn.querySelector('.mp-label').textContent : null,
        isDefault: document.querySelector('#model-picker .mp').classList.contains('is-default'),
        panelHidden: document.querySelector('#model-picker .mp-panel').classList.contains('hidden'),
        oldInputGone: !document.querySelector('#model-input'),
      };
    })()`);
    check('顶栏有模型下拉按钮', initial.hasBtn);
    check('原来的纯文本框已移除', initial.oldInputGone);
    check('未指定模型时按钮显示接口默认', initial.label === 'alpha-model-70b' && initial.isDefault, initial.label);
    check('面板默认是收起的', initial.panelHidden);

    console.log('\n点开下拉（应自动去假接口拉取模型列表）');
    await js(`document.querySelector('#model-picker .mp-btn').click(); true`);
    await sleep(300);
    const opened = await js(`(() => {
      const p = document.querySelector('#model-picker .mp-panel');
      return { hidden: p.classList.contains('hidden'), hasSearch: !!p.querySelector('.mp-search') };
    })()`);
    check('面板打开了', !opened.hidden);
    check('面板里有搜索框', opened.hasSearch);

    // 等自动拉取完成
    await sleep(2500);
    const listed = await js(`(() => {
      const items = [...document.querySelectorAll('#model-picker .mp-item')].map(i => i.dataset.model);
      const groups = [...document.querySelectorAll('#model-picker .mp-group')].map(g => g.textContent);
      const foot = document.querySelector('#model-picker .mp-foot').textContent;
      return { items, groups, foot };
    })()`);
    check('列表里出现了假接口返回的模型',
      listed.items.includes('alpha-model-70b') && listed.items.includes('zebra-model-7b'),
      JSON.stringify(listed.items));
    check('按组显示（来自接口 / 常用模型）',
      listed.groups.includes('来自接口'), JSON.stringify(listed.groups));
    check('有「用接口默认」这一项', listed.items.includes(''), JSON.stringify(listed.items));
    check('底部显示模型数量与更新时间',
      /共 \d+ 个可选模型/.test(listed.foot), listed.foot);

    // 光「DOM 里有这些项」还不够，得确认面板真的显示在窗口内、且没被别的元素盖住
    const geom = await js(`(() => {
      const r = (sel) => { const e = document.querySelector(sel); return e ? e.getBoundingClientRect() : null; };
      const btn = r('#model-picker .mp-btn');
      const panel = r('#model-picker .mp-panel');
      const item = r('#model-picker .mp-item');
      const cx = panel.x + panel.width / 2, cy = panel.y + panel.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        innerW: window.innerWidth, innerH: window.innerHeight,
        btn: { x: btn.x, y: btn.y, w: btn.width, h: btn.height, bottom: btn.bottom, right: btn.right },
        panel: { x: panel.x, y: panel.y, w: panel.width, h: panel.height, right: panel.right, bottom: panel.bottom },
        item: { w: item.width, h: item.height },
        hitClass: hit ? String(hit.className) : null,
      };
    })()`);
    check('下拉按钮在窗口内', geom.btn.x >= 0 && geom.btn.right <= geom.innerW && geom.btn.y >= 0);
    check('面板完全落在窗口内（不会掉到屏幕外）',
      geom.panel.x >= 0 && geom.panel.y >= 0 &&
      geom.panel.right <= geom.innerW && geom.panel.bottom <= geom.innerH,
      JSON.stringify(geom.panel) + ' 窗口 ' + geom.innerW + 'x' + geom.innerH);
    check('面板挂在按钮正下方', geom.panel.y >= geom.btn.bottom - 1,
      `面板 y=${geom.panel.y} 按钮 bottom=${geom.btn.bottom}`);
    check('面板尺寸正常', geom.panel.w >= 240 && geom.panel.h >= 80,
      `${geom.panel.w}x${geom.panel.h}`);
    check('列表项有正常的可点击高度', geom.item.h >= 20, String(geom.item.h));
    check('面板中心的元素属于面板内部（没被消息区盖住）',
      /mp-/.test(geom.hitClass || ''), String(geom.hitClass));

    // 留一张截图，方便人/工具复核下拉面板长什么样。
    // 注意：窗口被压在后台时 Chromium 不会合成新帧，capturePage 会拿到过期画面，
    // 所以先临时置顶并等一帧再截。（这个环境里窗口常被遮挡，截图仅供参考，判定以几何断言为准）
    try {
      const shotDir = path.join(app.getPath('userData'), 'model-e2e-out');
      fs.mkdirSync(shotDir, { recursive: true });
      win.setAlwaysOnTop(true);
      win.focus();
      await sleep(900);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(shotDir, 'model-dropdown.png'), img.toPNG());
      win.setAlwaysOnTop(false);
      console.log('  （截图：' + path.join(shotDir, 'model-dropdown.png') + '）');
    } catch (err) {
      console.log('  （截图失败，不影响测试：' + err.message + '）');
    }

    console.log('\n搜索过滤');
    await js(`(() => {
      const s = document.querySelector('#model-picker .mp-search');
      s.value = 'zebra';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    const filtered = await js(`(() => {
      const items = [...document.querySelectorAll('#model-picker .mp-item')].map(i => i.dataset.model);
      return { items };
    })()`);
    check('输入关键字后只剩匹配项 + 用接口默认',
      filtered.items.includes('zebra-model-7b') && !filtered.items.includes('alpha-model-70b'),
      JSON.stringify(filtered.items));

    console.log('\n用搜索框直接输入一个列表里没有的模型名（自定义）');
    await js(`(() => {
      const s = document.querySelector('#model-picker .mp-search');
      s.value = 'my-custom-model-v9';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    const custom = await js(`(() => {
      const c = document.querySelector('#model-picker .mp-custom');
      return { has: !!c, model: c ? c.dataset.model : null };
    })()`);
    check('出现「使用自定义模型」选项', custom.has && custom.model === 'my-custom-model-v9', JSON.stringify(custom));

    console.log('\n点选一个模型');
    await js(`(() => {
      const s = document.querySelector('#model-picker .mp-search');
      s.value = '';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(300);
    await js(`(() => {
      const item = [...document.querySelectorAll('#model-picker .mp-item')]
        .find(i => i.dataset.model === 'zebra-model-7b');
      item.click();
      return true;
    })()`);
    await sleep(900);

    const afterPick = await js(`(async () => {
      const s = await window.api.getState();
      const conv = s.conversations.find(c => c.title === '模型下拉测试') || s.conversations[0];
      return {
        label: document.querySelector('#model-picker .mp-label').textContent,
        panelHidden: document.querySelector('#model-picker .mp-panel').classList.contains('hidden'),
        convModel: conv.model,
        isDefault: document.querySelector('#model-picker .mp').classList.contains('is-default'),
      };
    })()`);
    check('对话的 model 真的被改成了选中的模型', afterPick.convModel === 'zebra-model-7b', afterPick.convModel);
    check('按钮文字同步更新', afterPick.label === 'zebra-model-7b', afterPick.label);
    check('不再是「接口默认」状态', afterPick.isDefault === false);
    check('选完面板自动收起', afterPick.panelHidden === true);

    console.log('\n换一个对话时跟着切');
    const switched = await js(`(async () => {
      const s = await window.api.getState();
      const conn = s.connections[0];
      const fresh = await window.api.createConversation({ connectionId: conn.id });
      await window.api.updateConversation(fresh.id, { title: '另一个对话', model: 'alpha-model-70b' });
      return fresh.id;
    })()`);
    win.webContents.reload();
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await sleep(1800);
    const afterSwitch = await js(`(async () => {
      // 新对话在最前面，点开它
      const items = [...document.querySelectorAll('#conv-list .conv-item')];
      const target = items.find(i => i.querySelector('.conv-name').textContent.includes('另一个对话'));
      if (target) target.click();
      await new Promise(r => setTimeout(r, 600));
      return {
        label: document.querySelector('#model-picker .mp-label').textContent,
        found: !!target,
      };
    })()`);
    check('切到另一个对话后按钮显示它自己的模型',
      afterSwitch.found && afterSwitch.label === 'alpha-model-70b',
      JSON.stringify(afterSwitch));
    check('（回归）新建对话的 id 拿到了', !!switched);

    console.log('\n参数面板里也是同一套下拉');
    await js(`document.querySelector('#btn-conv-params').click(); true`);
    await sleep(600);
    const inModal = await js(`(() => {
      const modal = document.querySelector('.modal');
      const picker = modal && modal.querySelector('.mp-btn');
      return { has: !!picker, label: picker ? picker.querySelector('.mp-label').textContent : null };
    })()`);
    check('对话参数弹窗里有模型下拉', inModal.has);
    check('下拉显示当前对话的模型', inModal.label === 'alpha-model-70b', inModal.label);
  } catch (err) {
    check('驱动自身没有抛异常', false, err.message);
  } finally {
    server.close();
  }

  const failed = checks.filter((c) => !c.pass);
  const outDir = path.join(app.getPath('userData'), 'model-e2e-out');
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, 'e2e-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    suite: 'model-picker-e2e', total: checks.length, failed: failed.length, checks,
  }, null, 2), 'utf8');
  console.log('\n模型下拉端到端：共 ' + checks.length + ' 项，失败 ' + failed.length + ' 项');
  console.log('报告：' + reportPath);

  if (failed.length) throw new Error(failed.length + ' 项检查未通过：' + failed.map((f) => f.name).join('、'));
};
