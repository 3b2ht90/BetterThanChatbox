// 验证「双击打包好的 exe」这条真实路径： npm run smoke:pkg
//
// 和 run-smoke.mjs 的区别：那个跑的是开发模式（node_modules 里的 electron.exe + 项目目录），
// 这个跑的是 dist 里的启动器，**不带任何 app 路径参数**，和用户双击完全一致。
// 因此它同时验证了三件事：启动器能兜住沙箱初始化失败、应用能从 resources/app 正常加载、
// 数据目录兜底逻辑不会把程序搞崩。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist', 'BetterThanChatbox');
const launcher = path.join(distDir, 'BetterThanChatbox.exe');

if (!fs.existsSync(launcher)) {
  console.error('找不到打包产物：' + launcher);
  console.error('请先执行： npm run build');
  process.exit(1);
}

const dataDir = path.join(root, '.pkg-data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const reportPath = path.join(root, 'test-artifacts', 'report.json');
fs.rmSync(reportPath, { force: true });

const env = {
  ...process.env,
  BTC_USER_DATA: dataDir,
  BTC_SMOKE: '1',
  BTC_SMOKE_SCRIPT: path.join(root, 'scripts', 'smoke-driver.js'),
};
delete env.ELECTRON_RUN_AS_NODE;

// 启动器自己会很快退出（它只负责把核心进程拉起来），所以要等报告文件，而不是等它
const child = spawn(launcher, [], { cwd: distDir, env, stdio: 'inherit' });

const waitReport = (timeoutMs) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (fs.existsSync(reportPath)) return resolve(true);
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(tick, 1000);
    };
    tick();
  });

child.on('error', (err) => {
  console.error('启动器拉起失败：' + err.message);
  process.exit(1);
});

child.on('exit', async (code) => {
  const ok = await waitReport(240000);
  if (!ok) {
    console.error('\n没有生成报告，打包版很可能没起来（启动器退出码 ' + code + '）');
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  let failed = (report.errors || []).length;
  const ignore = new Set(['chat.hasError', 'request.imagePartCount']);
  const bad = (report.checks || []).filter((c) => c.value === false || c.value === 0);
  for (const b of bad) if (!ignore.has(b.name)) failed++;
  console.log(`\n打包版：共 ${report.checks.length} 项检查，异常 ${failed} 项`);
  if (failed) console.log('异常项：' + bad.map((b) => b.name).join(', '));
  process.exit(failed ? 1 : 0);
});
