import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const label = 'local.autonews.web';
const domain = `gui/${process.getuid()}`;
const service = `${domain}/${label}`;
const runtimeDir = path.join(root, 'storage', 'service');
const logDir = path.join(root, 'storage', 'logs');
const plistFile = path.join(runtimeDir, `${label}.plist`);
const url = 'http://127.0.0.1:3000';

/** 执行系统命令，并在失败时返回可理解的错误信息。 */
function run(bin, args, allowFailure = false) {
  const result = spawnSync(bin, args, { encoding: 'utf8' });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(result.error?.message || result.stderr.trim() || `${bin} 执行失败`);
  }
  return result;
}

/** 判断本项目的网页服务是否已经交给系统管理。 */
function isLoaded() {
  return run('/bin/launchctl', ['print', service], true).status === 0;
}

/** 将路径与环境变量转换为可安全放入配置文件的 XML 文本。 */
function escapeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** 写入只在手动启动后生效的本地网页服务配置。 */
function writeServiceConfig() {
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const args = [
    process.execPath,
    path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'),
    'start',
    '-H',
    '127.0.0.1',
    '-p',
    '3000',
  ];
  const env = {
    AIDAILY_ROOT: root,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    PATH: [
      path.dirname(process.execPath),
      path.join(os.homedir(), '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      process.env.PATH || '',
    ].join(':'),
  };
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${escapeXml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${escapeXml(path.join(root, 'apps', 'web'))}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env)
    .map(([key, value]) => `<key>${key}</key><string>${escapeXml(value)}</string>`)
    .join('')}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${escapeXml(path.join(logDir, 'web.log'))}</string>
<key>StandardErrorPath</key><string>${escapeXml(path.join(logDir, 'web-error.log'))}</string>
</dict></plist>
`;
  const temporaryFile = `${plistFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, xml, { mode: 0o600 });
  fs.renameSync(temporaryFile, plistFile);
}

/** 检查固定网页端口是否被其他程序占用。 */
function isPortBusy() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: 3000 });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** 确认后台首页已能正常返回内容。 */
async function isReady() {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok && (await response.text()).includes('AI 每日报');
  } catch {
    return false;
  }
}

/** 启动生产后台并等待就绪，重复打开时复用现有服务。 */
async function start() {
  for (const relativePath of ['apps/web/.next/BUILD_ID', 'packages/core/dist/worker.mjs']) {
    if (!fs.existsSync(path.join(root, relativePath))) {
      throw new Error('尚未完成生产构建，请先在项目目录执行 npm ci && npm run build。');
    }
  }
  if (!isLoaded()) {
    if (await isPortBusy()) {
      throw new Error('3000 端口已被其他程序占用，请先释放端口再打开 AutoNews。');
    }
    writeServiceConfig();
    run('/bin/launchctl', ['bootstrap', domain, plistFile]);
  } else if (!(await isReady())) {
    run('/bin/launchctl', ['kickstart', '-k', service]);
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await isReady()) {
      console.log(`AutoNews 已启动：${url}`);
      console.log(`后台日志：${logDir}`);
      if (process.argv.includes('--open')) {
        run('/usr/bin/open', [url]);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`后台启动超时，请检查 ${path.join(logDir, 'web-error.log')}。`);
}

/** 停止本项目的网页服务，保留新闻、配置和数据库。 */
function stop() {
  if (isLoaded()) {
    run('/bin/launchctl', ['bootout', service]);
  }
  console.log('AutoNews 网页后台已停止。');
}

try {
  const action = process.argv[2] || 'status';
  if (action === 'start') {
    await start();
  } else if (action === 'stop') {
    stop();
  } else if (action === 'status') {
    console.log(isLoaded() && (await isReady()) ? `运行中：${url}` : '后台未运行或尚未就绪。');
  } else {
    throw new Error('用法：node scripts/local-web.mjs start [--open] | stop | status');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
