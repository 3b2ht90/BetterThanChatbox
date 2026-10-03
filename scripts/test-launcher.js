'use strict';

// 启动器（双击的那个 BetterThanChatbox.exe）的专项测试。
//
// 为什么值得单独测：用户报的「双击没反应」就是启动器判定逻辑的问题 ——
// 它原来把「1.5 秒内以退出码 0 退出」当成启动成功，于是既不再试别的参数、
// 也不弹任何提示，用户什么都看不到。这里用「假核心」复现各种启动行为来钉住它。
//
// 用法： node scripts/test-launcher.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail++;
    console.log('  ✗ ' + name + '  → ' + err.message);
  }
}

const root = path.resolve(__dirname, '..');
const csc = findCsc();
if (!csc) {
  console.error('找不到 csc.exe（C# 编译器），无法编译测试用的假核心');
  process.exit(1);
}

function findCsc() {
  const candidates = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-launcher-'));

// 每个场景一个独立目录：里面有编译好的启动器 + app-runtime\BetterThanChatboxCore.exe（=假核心）
function makeScenario(name) {
  const dir = path.join(tmp, name);
  const runtime = path.join(dir, 'app-runtime');
  fs.mkdirSync(runtime, { recursive: true });
  execFileSync(csc, ['/nologo', '/target:winexe', '/codepage:65001',
    '/out:' + path.join(dir, 'BetterThanChatbox.exe'), path.join(root, 'scripts', 'launcher.cs')],
    { stdio: 'pipe' });
  execFileSync(csc, ['/nologo', '/target:exe', '/codepage:65001',
    '/out:' + path.join(runtime, 'BetterThanChatboxCore.exe'), path.join(root, 'scripts', 'fake-core.cs')],
    { stdio: 'pipe' });
  return { dir, exe: path.join(dir, 'BetterThanChatbox.exe'), runtime };
}

/** 跑启动器，返回退出码、日志、以及假核心看到的环境 */
function runLauncher(scenario, mode, opts = {}) {
  const dumpDir = path.join(scenario.dir, 'dump');
  fs.mkdirSync(dumpDir, { recursive: true });
  const env = {
    ...process.env,
    BTC_SMOKE: '1',            // 让启动器不弹窗、并且一定写日志
    FAKE_CORE_MODE: mode,
    FAKE_CORE_DUMP_DIR: dumpDir,
    APPDATA: opts.appData || path.join(scenario.dir, 'appdata'),
    LOCALAPPDATA: opts.localAppData || path.join(scenario.dir, 'localappdata'),
  };
  if (opts.appData) fs.mkdirSync(opts.appData, { recursive: true });
  if (opts.localAppData) fs.mkdirSync(opts.localAppData, { recursive: true });

  let code = 0;
  try {
    execFileSync(scenario.exe, [], { env, stdio: 'pipe', timeout: 60000 });
  } catch (err) {
    code = typeof err.status === 'number' ? err.status : -1;
  }
  const logPath = path.join(scenario.dir, '启动日志.txt');
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const dumps = fs.existsSync(dumpDir)
    ? fs.readdirSync(dumpDir).map((f) => fs.readFileSync(path.join(dumpDir, f), 'utf8'))
    : [];
  return { code, log, dumps };
}

/** 数「真正尝试启动」的次数（日志里还有以「第 N 次」开头的说明行，不能一起数进去） */
function countAttempts(log) {
  return (log.match(/^第 \d+ 次.*(进程存活|进程在 \d+ 毫秒内退出|启动失败|拿不到退出状态)/gm) || []).length;
}

console.log('场景 1：核心一启动就干净退出（退出码 0），并没有别的实例在跑');
{
  const sc = makeScenario('exit0-alone');
  const { code, log } = runLauncher(sc, 'exit0');
  check('不再把「退出码 0」当成启动成功', () => {
    if (/视为成功/.test(log)) throw new Error('还是当成成功了:\n' + log);
    if (!/并没有任何实例在跑/.test(log)) throw new Error('没识别出「没有实例在跑」:\n' + log);
  });
  check('会继续尝试后面的所有参数组合（不再早早放弃）', () => {
    const n = countAttempts(log);
    if (n < 5) throw new Error('只试了 ' + n + ' 种方式（应为 5）:\n' + log);
  });
  check('最后明确报「都没能起来」并给出退出码 5（用户能看到弹窗/日志）', () => {
    if (!/所有启动方式都没能让程序起来/.test(log)) throw new Error(log);
    if (code !== 5) throw new Error('退出码是 ' + code + '，应为 5');
  });
  check('日志里写清了每一次的退出码，便于排查', () => {
    if (!/退出码 0（0x00000000）/.test(log)) throw new Error(log);
  });
}

console.log('\n场景 2：主进程报告「已有实例在运行」（退出码 3）');
{
  const sc = makeScenario('exit3');
  const { code, log } = runLauncher(sc, 'exit3');
  check('当成「已在运行」而不是启动失败', () => {
    if (!/已经有一个实例在运行/.test(log)) throw new Error(log);
    if (/所有启动方式都没能让程序起来/.test(log)) throw new Error('被误判成失败了:\n' + log);
  });
  check('不再继续试后面的方式（没必要重复拉起）', () => {
    const n = countAttempts(log);
    if (n !== 1) throw new Error('试了 ' + n + ' 次，应只试 1 次:\n' + log);
  });
  check('启动器本身退出码 0（对调用方=正常）', () => {
    if (code !== 0) throw new Error('退出码 ' + code);
  });
  check('日志里说明了「是把前台窗口交给已有实例」', () => {
    if (!/本来就在运行/.test(log)) throw new Error(log);
  });
}

console.log('\n场景 3：核心活过 1.5 秒（正常启动）');
{
  const sc = makeScenario('alive');
  // 用 crashThenAlive：第一次崩（模拟沙箱），第二次活着 —— 跟真实环境一样
  fs.rmSync(path.join(os.tmpdir(), 'btc-fake-crash-once.marker'), { force: true });
  const { code, log } = runLauncher(sc, 'crashThenAlive');
  check('第 1 次崩、第 2 次活 → 判定成功', () => {
    if (!/进程存活，已启动成功/.test(log)) throw new Error(log);
  });
  check('成功时不再往下试', () => {
    const n = countAttempts(log);
    if (n !== 2) throw new Error('试了 ' + n + ' 次，应为 2:\n' + log);
  });
  check('启动器退出码 0', () => {
    if (code !== 0) throw new Error('退出码 ' + code);
  });
  try { execFileSync('taskkill', ['/F', '/IM', 'BetterThanChatboxCore.exe'], { stdio: 'pipe' }); } catch { }
}

console.log('\n场景 4：APPDATA 根目录能写、但 %APPDATA%\\BetterThanChatbox 写不进去');
{
  const sc = makeScenario('appdata-subdir-blocked');
  const appData = path.join(sc.dir, 'appdata2');
  fs.mkdirSync(appData, { recursive: true });
  // 把 BetterThanChatbox 做成一个「文件」—— 探测要求建目录并往里写，必然失败
  fs.writeFileSync(path.join(appData, 'BetterThanChatbox'), 'not a directory');
  const { log, dumps } = runLauncher(sc, 'exit0', { appData });
  check('探测的是真正的数据目录，而不是只看 %APPDATA% 根目录', () => {
    const redirected = dumps.some((d) => /^APPDATA=.*data/m.test(d) && !/appdata2/.test(d));
    if (!redirected) throw new Error('没有重定向数据目录，假核心看到的是:\n' + dumps.join('\n---\n'));
  });
  check('重定向到程序目录\\data 后，子进程拿到的是新 APPDATA', () => {
    const ok = dumps.some((d) => {
      const m = /^APPDATA=(.*)$/m.exec(d);
      return m && path.resolve(m[1]) === path.resolve(path.join(sc.dir, 'data'));
    });
    if (!ok) throw new Error('假核心看到的 APPDATA 不对:\n' + dumps.join('\n---\n'));
  });
}

console.log('\n场景 5：主进程报告「数据目录写不进去」（退出码 4）');
{
  const sc = makeScenario('exit4');
  const { log, dumps } = runLauncher(sc, 'exit4');
  check('识别出是数据目录问题，并说明会重定向后重试', () => {
    if (!/数据目录写不进去/.test(log)) throw new Error(log);
  });
  check('重试时确实换了数据目录（后续子进程拿到重定向后的 APPDATA）', () => {
    const redirected = dumps.slice(1).some((d) => /^APPDATA=.*[\\/]data$/m.test(d.trim()));
    if (!redirected) throw new Error('后续尝试没有重定向:\n' + dumps.join('\n---\n'));
  });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
