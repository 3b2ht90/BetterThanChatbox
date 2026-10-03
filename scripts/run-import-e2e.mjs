// 跑「导入对话」的端到端测试（走打包产物）。
// 用法： npm run e2e:import   （需要先 npm run build）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist', 'BetterThanChatbox');
const launcher = path.join(distDir, 'BetterThanChatbox.exe');

if (!fs.existsSync(launcher)) {
  console.error('找不到打包产物：' + launcher);
  console.error('请先执行： npm run build');
  process.exit(1);
}

const dataDir = path.join(root, '.e2e-import-data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const reportPath = path.join(dataDir, 'import-e2e-out', 'e2e-report.json');

const env = {
  ...process.env,
  BTC_USER_DATA: dataDir,
  BTC_SMOKE: '1',
  BTC_SMOKE_SCRIPT: path.join(root, 'scripts', 'import-e2e-driver.js'),
};
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(launcher, [], { cwd: distDir, env, stdio: 'inherit' });

const waitReport = (timeoutMs) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (fs.existsSync(reportPath)) return resolve(true);
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(tick, 500);
    };
    tick();
  });

child.on('error', (err) => {
  console.error('启动器拉起失败：' + err.message);
  process.exit(1);
});

child.on('exit', async (code) => {
  const ok = await waitReport(180000);
  if (!ok) {
    console.error('\n没有生成报告，打包版很可能没起来（启动器退出码 ' + code + '）');
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const failed = (report.checks || []).filter((c) => !c.pass);
  console.log(`\n导入对话端到端：共 ${report.total} 项检查，失败 ${failed.length} 项`);
  if (failed.length) console.log('失败项：' + failed.map((f) => f.name).join(', '));
  console.log('报告：' + reportPath);
  process.exit(failed.length ? 1 : 0);
});
