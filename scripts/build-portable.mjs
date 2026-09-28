// 免安装（portable）打包：复用 node_modules/electron 自带的运行时，
// 不依赖 electron-builder，也不需要联网下载签名工具。
//
// 产物结构：
//   dist/BetterThanChatbox/
//     BetterThanChatbox.exe      ← 用户双击这个（C# 启动器，见 scripts/launcher.cs）
//     使用说明.txt
//     app-runtime/               ← Electron 运行时 + 应用代码
//       BetterThanChatboxCore.exe
//       ...
//
// 为什么不直接把 electron.exe 改名当入口：受限环境里 Chromium 沙箱会在 JS 起来之前
// 就崩掉（退出码 0x80000003），而崩溃早于 main.js，所以没法在应用里补 --no-sandbox。
// 启动器负责「先正常启动，失败就自动 --no-sandbox 重试」，用户双击一个 exe 就行。
//
// 用法： node scripts/build-portable.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', 'electron', 'dist');
const outRoot = path.join(root, 'dist');
const appName = 'BetterThanChatbox';
const out = path.join(outRoot, appName);
const runtimeDir = path.join(out, 'app-runtime');
const resApp = path.join(runtimeDir, 'resources', 'app');
const coreName = appName + 'Core.exe';

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// 找一个能用的 C# 编译器（Windows 自带 .NET Framework 4.x 就带 csc.exe）
function findCsc() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

if (!fs.existsSync(src)) {
  console.error('找不到 Electron 运行时：' + src);
  console.error('请先在项目根目录执行： npm install');
  process.exit(1);
}

console.log('清理输出目录…');
rmrf(out);
fs.mkdirSync(outRoot, { recursive: true });

console.log('复制 Electron 运行时 → app-runtime\\');
copyDir(src, runtimeDir);

const exeSrc = path.join(runtimeDir, 'electron.exe');
const exeDst = path.join(runtimeDir, coreName);
if (fs.existsSync(exeSrc)) fs.renameSync(exeSrc, exeDst);
else {
  console.error('异常：运行时里没有 electron.exe');
  process.exit(1);
}

console.log('复制应用文件…');
fs.mkdirSync(resApp, { recursive: true });
for (const item of ['package.json', 'app', 'README.md', 'assets']) {
  const s = path.join(root, item);
  if (!fs.existsSync(s)) continue;
  const d = path.join(resApp, item);
  if (fs.statSync(s).isDirectory()) copyDir(s, d);
  else fs.copyFileSync(s, d);
}

// 只带上运行期真正需要的依赖（主进程渲染 Markdown / 代码高亮）
const depsDir = path.join(resApp, 'node_modules');fs.mkdirSync(depsDir, { recursive: true });
for (const dep of ['marked', 'highlight.js']) {
  const s = path.join(root, 'node_modules', dep);
  if (fs.existsSync(s)) copyDir(s, path.join(depsDir, dep));
  else console.warn('警告：缺少依赖 ' + dep);
}

// 精简运行时不必要的东西
for (const junk of ['resources/default_app.asar', 'version', 'LICENSE', 'LICENSES.chromium.html']) {
  rmrf(path.join(runtimeDir, junk));
}
// 图标的构建日志不用随程序发布
rmrf(path.join(resApp, 'assets', '_icon-build.log'));
const pkg = JSON.parse(fs.readFileSync(path.join(resApp, 'package.json'), 'utf8'));
delete pkg.devDependencies;
delete pkg.scripts;
fs.writeFileSync(path.join(resApp, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');

// ---------- 编译启动器 ----------
const launcherExe = path.join(out, appName + '.exe');
const csc = findCsc();
if (!csc) {
  console.error('\n找不到 C# 编译器 csc.exe，无法生成启动器。');
  console.error('正常 Windows 自带：%WINDIR%\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe');
  process.exit(1);
}

console.log('编译启动器 → ' + path.basename(launcherExe));
// 某些受限环境里子进程只能写工作区，csc 连 %TEMP% 都建不了临时文件，
// 所以把 TMP/TEMP 指到项目内的临时目录（正常机器上也无害）。
const buildTmp = path.join(root, '.build-tmp');
fs.mkdirSync(buildTmp, { recursive: true });
const buildEnv = { ...process.env, TMP: buildTmp, TEMP: buildTmp };
delete buildEnv.ELECTRON_RUN_AS_NODE;

const csFile = path.join(root, 'scripts', 'launcher.cs');
// 图标：把 assets/icon.ico 编进启动器 exe，用户双击的 BetterThanChatbox.exe 就带图标了
const iconFile = path.join(root, 'assets', 'icon.ico');
if (!fs.existsSync(iconFile)) {
  console.warn('警告：找不到 ' + iconFile + '，启动器将使用默认图标。');
  console.warn('       生成图标： node_modules\\electron\\dist\\electron.exe --no-sandbox scripts\\make-icon.cjs');
}
const cscArgs = ['/nologo', '/target:winexe', '/codepage:65001', '/r:System.Windows.Forms.dll',
  '/out:' + launcherExe];
if (fs.existsSync(iconFile)) cscArgs.push('/win32icon:' + iconFile);
cscArgs.push(csFile);
const r = spawnSync(csc, cscArgs, { stdio: 'inherit', env: buildEnv });
if (r.status !== 0 || !fs.existsSync(launcherExe)) {
  console.error('\n启动器编译失败（csc 退出码 ' + r.status + '）');
  process.exit(1);
}
rmrf(buildTmp);

fs.writeFileSync(path.join(out, '使用说明.txt'), [
  appName + ' —— 自己填 API Key 的极简 AI 聊天软件',
  '',
  '1. 双击 ' + appName + '.exe 直接运行，无需安装、无需命令行参数。',
  '   （app-runtime 文件夹是程序本体，别删、别单独移动，要和 exe 放在一起）',
  '2. 第一次打开会弹出「设置」，点「＋ 添加接口」，填：',
  '   - 接口类型：OpenAI 兼容 / Anthropic Claude / Google Gemini',
  '   - Base URL：例如 https://api.deepseek.com/v1（Claude 和 Gemini 官方可留空）',
  '   - API Key、模型名，然后点「保存」和「设为当前」。',
  '3. 回到主界面就能聊了。Enter 发送，Shift+Enter 换行，',
  '   可以把图片/文件拖进窗口、Ctrl+V 粘贴截图，或点 📎 添加附件。',
  '4. 主题：顶栏的 ☀ / 🌙 按钮一键切换「浅色米白 / 深色深绿」；',
  '   想跟随 Windows 的深浅色设置，去 设置 → 通用设置 → 主题 选「跟随系统」。',
  '5. 回答不满意：鼠标移到那条回答上点「重新回答」，旧回答不会丢，',
  '   标题旁会出现 ‹ 2/3 ›，用 ‹ › 在多个版本之间切换（当前显示的那版才参与后面的对话）。',
  '   想改自己的提问：鼠标移到提问上点「编辑」，Enter 保存（Shift+Enter 换行、Esc 取消），',
  '   旧提问和旧回答都留作历史版本，随时能切回去对比。',
  '',
  '数据（含 API Key）保存在：%APPDATA%\\' + appName + '\\data.json',
  '设置面板里的「打开数据目录」可直接打开它（面板底部也显示真实路径）。',
  '如果 %APPDATA% 不可写（受限环境/只读目录），数据会自动改存到：程序目录\\data\\',
  '',
  '启动器说明：双击后会先用正常方式（带 Chromium 沙箱）启动，',
  '若因为受限环境起不来，会自动换参数再试（最多 5 种），全程不需要你操作。',
  '万一 5 种都没起来，同目录会生成「启动日志.txt」，把它发给我就能定位原因。',
  '',
].join('\r\n'), 'utf8');

console.log('\n完成！免安装程序在： ' + launcherExe);
console.log('双击即可运行；数据默认保存在 %APPDATA%\\' + appName + '\\data.json');
console.log('运行时本体在 app-runtime\\（' + coreName + '），整个文件夹一起拷贝。');
