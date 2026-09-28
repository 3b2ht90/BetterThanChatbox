// 一键跑界面冒烟测试： npm run smoke
// 会启动真实的 Electron 窗口，连一个本地假接口走完整流程，并把截图 + 报告写到 test-artifacts/
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron';
const electron = path.join(root, 'node_modules', 'electron', 'dist', exeName);

if (!fs.existsSync(electron)) {
  console.error('找不到 Electron，请先执行 npm install');
  process.exit(1);
}

const dataDir = path.join(root, '.smoke-data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const env = {
  ...process.env,
  BTC_USER_DATA: dataDir,
  BTC_SMOKE: '1',
  BTC_SMOKE_SCRIPT: path.join(root, 'scripts', 'smoke-driver.js'),
};
delete env.ELECTRON_RUN_AS_NODE;
// ELECTRON_RUN_AS_NODE 会让 electron 退化成纯 node，必须清掉

const child = spawn(electron, [root, '--no-sandbox'], { cwd: root, env, stdio: 'inherit' });

child.on('exit', (code) => {
  const reportPath = path.join(root, 'test-artifacts', 'report.json');
  let failed = 0;
  if (fs.existsSync(reportPath)) {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    failed = (report.errors || []).length;
    const bad = (report.checks || []).filter((c) => c.value === false || c.value === 0);
    const ignore = new Set(['chat.hasError', 'request.imagePartCount']);
    for (const b of bad) if (!ignore.has(b.name)) failed++;
    console.log(`\n共 ${report.checks.length} 项检查，异常 ${failed} 项`);
    if (failed) console.log('异常项：' + bad.map((b) => b.name).join(', '));
  } else {
    console.error('\n没有生成报告，测试很可能崩了');
    failed = 1;
  }
  process.exit(failed ? 1 : (code ?? 0));
});
