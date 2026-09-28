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

const HTML = `<!doctype html>
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
    font-size: 78px;
    font-weight: 700;
    line-height: 1.03;
    letter-spacing: -1.5px;
    text-align: center;
    text-shadow: 0 3px 10px rgba(0,0,0,0.35);
  }
  .txt .small { font-size: 62px; letter-spacing: -0.5px; }
</style></head>
<body>
  <div class="icon">
    <div class="glow"></div>
    <div class="frame"></div>
    <div class="txt">BetterThan<br><span class="small">Chatbox</span></div>
  </div>
</body></html>`;

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

    const tmp = path.join(OUT_DIR, '_icon.html');
    fs.writeFileSync(tmp, HTML, 'utf8');
    await win.loadFile(tmp);
    log('页面已加载，等待渲染…');
    await new Promise((r) => setTimeout(r, 900));

    const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
    if (!image || image.isEmpty()) return fail('capturePage 返回空图像');
    const png512 = image.toPNG();
    log('截图大小：' + image.getSize().width + 'x' + image.getSize().height + '，PNG ' + png512.length + ' bytes');
    if (png512.length < 2000) return fail('截图内容异常（太小）');

    fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png512);
    log('已写 icon.png');

    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const pngs = [];
    for (const size of sizes) {
      const resized = image.resize({ width: size, height: size, quality: 'best' });
      pngs.push({ size, buffer: resized.toPNG() });
    }
    const ico = buildIco(pngs);
    fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
    log('已写 icon.ico（' + sizes.join('/') + '，共 ' + ico.length + ' bytes）');

    fs.unlinkSync(tmp);
    log('完成');
    app.exit(0);
  } catch (err) {
    fail(String((err && err.stack) || err));
  }
});
