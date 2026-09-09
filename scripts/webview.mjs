import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DevToolsError } from './lib/devtools.mjs';
import { discoverWebViews, isPackageName, isTargetId, WebViewError } from './lib/webview.mjs';

export function parseOptions(args) {
  const options = {};
  const seen = new Set();
  const values = { '--adb': 'adb', '--serial': 'serial', '--package': 'packageName', '--target': 'target' };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag)) throw new WebViewError('invalid_arguments');
    seen.add(flag);
    if (flag === '--help' || flag === '--connect') {
      options[flag.slice(2)] = true;
      continue;
    }
    if (!Object.hasOwn(values, flag)) throw new WebViewError('invalid_arguments');
    const value = args[++index];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('-') || /[\x00-\x1f\x7f]/.test(value)) {
      throw new WebViewError('invalid_arguments');
    }
    options[values[flag]] = value;
  }
  if (options.packageName !== undefined && !isPackageName(options.packageName)) throw new WebViewError('invalid_arguments');
  if (options.serial !== undefined && /\s/.test(options.serial)) throw new WebViewError('invalid_arguments');
  if (options.target !== undefined && (!options.connect || !isTargetId(options.target))) throw new WebViewError('invalid_arguments');
  if (!options.help && !options.packageName) throw new WebViewError('invalid_arguments');
  return options;
}

export function waitForAbort(signal) {
  if (!(signal instanceof AbortSignal)) return Promise.reject(new WebViewError('invalid_arguments'));
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveWait) => {
    // AbortSignal 监听器本身不会维持 Node 进程；保留转发期间需要显式存活句柄。
    const keepAlive = setInterval(() => {}, 1000);
    signal.addEventListener('abort', () => {
      clearInterval(keepAlive);
      resolveWait();
    }, { once: true });
  });
}

export async function main(args, {
  discover = discoverWebViews, signal, waitForStop = waitForAbort,
  stdout = (text) => console.log(text), stderr = (text) => console.error(text),
  nodeVersion = process.versions.node,
} = {}) {
  let options;
  try { options = parseOptions(args); }
  catch {
    stderr('参数无效。使用 node scripts/webview.mjs --help 查看说明。');
    return 2;
  }
  if (options.help) {
    stdout([
      'Android WebView 工作台：页面发现与 DevTools 连接（仅使用 Node.js 内置模块）',
      '发现：node scripts/webview.mjs --package <APP 包名> [--adb <adb.exe 路径>] [--serial <设备序列号>]',
      '连接：追加 --connect；多页面或不完整列表时，必须追加 --target <发现结果中的页面 ID>。',
      '页面 ID 绑定设备、APP、socket 和 CDP 页面标识，不使用容易错选的列表序号。',
      '要求：Node.js 22.12+、已授权 USB 设备；手动打开 APP，并由 APP 自身启用 WebView 调试。',
      '仅关联标准带 PID 的 webview_devtools_remote socket；不绕过 APP 调试限制，不启动或修改 APP。',
      '发现模式会创建临时 ADB 转发，并在输出结果前清理。',
      '连接模式校验 CDP 后保留转发：在桌面 Chrome 打开输出的 devtoolsFrontendUrl；按 Ctrl+C 清理退出。',
      '也可在 chrome://inspect/#devices 的 Configure 中添加输出的 forwardingAddress。',
      '连接模式输出 JSON Lines；不会自动打开浏览器，也不代表投屏或输入功能已实现。',
      '不输出设备序列号、页面 URL/标题或认证数据；连接模式仅额外输出本机调试地址。',
      '只清理仍匹配本会话所有权的转发，不使用 remove-all 或 kill-server；强制结束进程无法保证清理。',
      '退出码：0 完成；1 无可用页面、连接或清理失败；2 参数/运行时错误；Ctrl+C 为 130。',
    ].join('\n'));
    return 0;
  }
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (!(major > 22 || (major === 22 && minor >= 12))) {
    stderr('请使用 Node.js 22.12 或更高版本。');
    return 2;
  }
  if (options.connect && !(signal instanceof AbortSignal)) {
    stderr('连接模式需要可取消的生命周期；请通过命令行入口启动。');
    return 2;
  }
  let session;
  let report;
  let failure;
  let cleanup;
  let connected = false;
  try {
    session = await discover({ adb: options.adb, serial: options.serial,
      packageName: options.packageName, signal });
    report = { schemaVersion: 1, event: 'discovered',
      scope: '仅发现指定 APP 的标准 WebView 页面；不代表投屏、输入或目标 APP 已通过验收。',
      ready: session.targets.some((target) => target.inspectable), complete: session.complete,
      targets: session.targets, warnings: session.warnings };
    if (options.connect) {
      const connection = await session.verify(options.target);
      connected = true;
      stdout(JSON.stringify({ ...report, event: 'connected', ready: true, connection,
        notice: '请保持本进程运行，在桌面 Chrome 打开调试地址；按 Ctrl+C 清理退出。' }));
      await waitForStop(signal);
    }
  } catch (error) {
    failure = error instanceof WebViewError || error instanceof DevToolsError
      ? error : new WebViewError('webview_failed');
  } finally {
    try { cleanup = session ? await session.close() : failure?.cleanup; }
    catch { cleanup = { ok: false, code: 'cleanup_incomplete' }; }
  }
  if (failure && !(signal?.aborted && failure.code === 'aborted')) {
    stderr(JSON.stringify({ schemaVersion: 1, event: 'error',
      error: { code: failure.code, message: failure.message }, ...(cleanup ? { cleanup } : {}) }));
    return 1;
  }
  if (connected || signal?.aborted) {
    stdout(JSON.stringify({ schemaVersion: 1, event: 'closed', ...(cleanup ? { cleanup } : {}) }));
    return cleanup?.ok === false ? 1 : 0;
  }
  stdout(JSON.stringify({ ...report, cleanup }));
  return report.ready && cleanup?.ok === true ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  let interrupted;
  const onInterrupt = () => { interrupted ??= 130; controller.abort(); };
  const onTerminate = () => { interrupted ??= 143; controller.abort(); };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
    const code = await main(process.argv.slice(2), { signal: controller.signal });
    process.exitCode = code === 0 && interrupted ? interrupted : code;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}
