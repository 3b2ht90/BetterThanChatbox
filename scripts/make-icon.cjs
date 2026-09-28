// 用 Electron 渲染 App 图标：深绿色方块 + 米色 BetterThanChatbox
// 运行（受限环境需要 --no-sandbox）：
//   node_modules\electron\dist\electron.exe --no-sandbox scripts\make-icon.cjs
// 产物： assets\icon.png (512x512)、assets\icon.ico (16/24/32/48/64/128/256)
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'assets');
const LOG = path.join(OUT_DIR, '_icon-build.log');
const SIZE = 512;

const lines = [];
function log(msg) {
  lines.push(msg);
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(LOG, lines.join('\n'), 'utf8');
  } catch { /* ignore */ }
  console.log(msg);
}

// 大尺寸：三个单词各占一行；小尺寸：BTC 字母组合（三行文字缩到 16px 会糊成一团）
const HTML_FULL = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; width: ${SIZE}px; height: ${SIZE}px; overflow: hidden; }
  .icon {
    width: ${SIZE}px; height: ${SIZE}px;
    background: linear-gradient(160deg, #14503C 0%, #0E3B2E 55%, #0A2C22 100%);
    display: flex; align-items: center; justify-content: center;
    position: relative;
    font-family: "Segoe UI", "Segoe UI Variable Display", Arial, sans-serif;
  }
  .frame {
    position: absolute; inset: 26px; border-radius: 46px;
    border: 3px solid rgba(240, 227, 199, 0.18);
  }
  .glow {
    position: absolute; width: 330px; height: 330px; border-radius: 50%;
    background: radial-gradient(circle, rgba(240,227,199,0.11) 0%, rgba(240,227,199,0) 70%);
    top: 36px; left: 91px;
  }
  .txt {
    position: relative;
    color: #F0E3C7;
    font-size: 104px;
    font-weight: 700;
    line-height: 1.06;
    letter-spacing: -2px;
    text-align: center;
    text-shadow: 0 3px 10px rgba(0,0,0,0.35);
  }
</style></head>
<body>
  <div class="icon">
    <div class="glow"></div>
    <div class="frame"></div>
    <div class="txt">Better<br>Than<br>Chatbox</div>
  </div>
</body></html>`;

// 小尺寸版本：粗体 BTC 三个字母，撑满方块、笔画足够粗才经得起缩到 16px
const HTML_MONO = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; width: ${SIZE}px; height: ${SIZE}px; overflow: hidden; }
  .icon {
    width: ${SIZE}px; height: ${SIZE}px;
    background: linear-gradient(160deg, #14503C 0%, #0E3B2E 55%, #0A2C22 100%);
    display: flex; align-items: center; justify-content: center;
    position: relative;
    font-family: "Segoe UI Black", "Segoe UI", Arial, sans-serif;
  }
  .frame {
    position: absolute; inset: 34px; border-radius: 40px;
    border: 4px solid rgba(240, 227, 199, 0.22);
  }
  .mono {
    position: relative;
    color: #F0E3C7;
    font-size: 195px;
    font-weight: 900;
    letter-spacing: 4px;
    text-indent: 4px;          /* 抵消最后一个字母右侧的 letter-spacing，保证视觉居中 */
    line-height: 1;
    text-shadow: 0 4px 12px rgba(0,0,0,0.35);
  }
</style></head>
<body>
  <div class="icon">
    <div class="frame"></div>
    <div class="mono">BTC</div>
  </div>
</body></html>`;

// 尺寸 >= 64 用全名，更小的用 BTC
const MONO_MAX = 48;
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const entries = [];
  let offset = 6 + count * 16;
  const blobs = [];
  for (const { size, buffer } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buffer.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += buffer.length;
    entries.push(e);
    blobs.push(buffer);
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

function fail(msg) {
  log('失败：' + msg);
  app.exit(1);
}

/**
 * 量出「米色文字」的包围盒。
 * 用途：字号太大文字会被画布切掉，肉眼看小图看不出来 —— 一旦贴到边缘就直接报错。
 * 描边框的米色只有 18% 不透明度（≈ rgb(59,58,47)），亮度远低于阈值，不会被算进来。
 */
function measureInk(img) {
  const { width, height } = img.getSize();
  const buf = img.toBitmap(); // BGRA
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const b = buf[i], g = buf[i + 1], r = buf[i + 2];
      if (r > 170 && g > 150 && b > 120) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY, count, width, height };
}

function checkInk(tag, img) {
  const m = measureInk(img);
  log('  ' + tag + ' 文字范围：x ' + m.minX + '..' + m.maxX + ' / y ' + m.minY + '..' + m.maxY +
    '（' + (m.maxX - m.minX + 1) + 'x' + (m.maxY - m.minY + 1) + '，' + m.count + ' 个米色像素）');
  if (m.maxX < 0) return fail(tag + '：没找到任何文字像素');
  const touch = [];
  if (m.minX <= 0) touch.push('左');
  if (m.maxX >= m.width - 1) touch.push('右');
  if (m.minY <= 0) touch.push('上');
  if (m.maxY >= m.height - 1) touch.push('下');
  if (touch.length) {
    return fail(tag + '：文字贴到画布' + touch.join('/') + '边缘，说明字号过大被切掉了');
  }
  const margin = Math.min(m.minX, m.minY, m.width - 1 - m.maxX, m.height - 1 - m.maxY);
  if (margin < 8) log('  ⚠️  ' + tag + '：文字离边缘只有 ' + margin + 'px，缩到 16px 可能发虚');
  return true;
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    log('Electron ' + process.versions.electron + ' / Node ' + process.versions.node);
    log('输出目录：' + OUT_DIR);

    const win = new BrowserWindow({
      width: SIZE,
      height: SIZE,
      show: false,
      frame: false,
      backgroundColor: '#0E3B2E',
      useContentSize: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });

    // render(html) → 截图成一个 NativeImage
    async function render(html, tag) {
      const tmp = path.join(OUT_DIR, '_icon-' + tag + '.html');
      fs.writeFileSync(tmp, html, 'utf8');
      await win.loadFile(tmp);
      await new Promise((r) => setTimeout(r, 900));
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
      fs.unlinkSync(tmp);
      if (!img || img.isEmpty()) throw new Error(tag + '：capturePage 返回空图像');
      return img;
    }

    log('渲染大尺寸画面（Better / Than / Chatbox）…');
    const imgFull = await render(HTML_FULL, 'full');
    if (checkInk('三行全名', imgFull) !== true) return;
    const pngFull = imgFull.toPNG();
    if (pngFull.length < 2000) return fail('全名画面内容异常（太小）');
    fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), pngFull);
    log('已写 icon.png（' + SIZE + 'x' + SIZE + '，' + pngFull.length + ' bytes）');

    log('渲染小尺寸画面（BTC）…');
    const imgMono = await render(HTML_MONO, 'mono');
    if (checkInk('BTC 字母', imgMono) !== true) return;
    log('BTC 画面 OK（' + imgMono.toPNG().length + ' bytes）');

    const pngs = [];
    const monoList = [];
    for (const size of SIZES) {
      const source = size <= MONO_MAX ? imgMono : imgFull;
      const resized = source.resize({ width: size, height: size, quality: 'best' });
      pngs.push({ size, buffer: resized.toPNG() });
      if (size <= MONO_MAX) monoList.push(size);
    }
    const ico = buildIco(pngs);
    fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
    log('已写 icon.ico：' + SIZES.join('/') + '，其中 ' + monoList.join('/') + ' 用 BTC 字母组合，其余用三行全名');
    log('共 ' + ico.length + ' bytes');

    log('完成');
    app.exit(0);
  } catch (err) {
    fail(String((err && err.stack) || err));
  }
});
