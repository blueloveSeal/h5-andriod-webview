import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// 仅执行固定的只读 ADB 命令；不转发端口、不启动 APP、不关闭共用 ADB Server。
export async function runAdb(file, args) {
  try {
    const { stdout } = await execute(file, args, {
      encoding: 'utf8', timeout: 8_000, maxBuffer: 512 * 1024,
      windowsHide: true, shell: false,
    });
    return { ok: true, stdout };
  } catch (error) {
    // 原始错误可能包含设备数据或命令输出，不能进入诊断报告。
    const code = error.code === 'ENOENT' ? 'not_found'
      : error.killed || error.code === 'ETIMEDOUT' ? 'timeout' : 'command_failed';
    return { ok: false, code };
  }
}

export function parseDevices(output) {
  const lines = output.split(/\r?\n/);
  const header = lines.findIndex((line) => line.trim() === 'List of devices attached');
  if (header < 0) return null;
  return lines.slice(header + 1).filter((line) => line.trim() && !line.startsWith('*'))
    .map((line) => {
      const [serial, state, next] = line.trim().split(/\s+/);
      return { serial, state: state === 'no' && next === 'permissions' ? 'no_permissions' : state };
    });
}

export function parseWebViewVersion(output) {
  return output.match(/Current WebView package \(name, version\):\s*\([a-zA-Z0-9_.]+,\s*([0-9]+(?:\.[0-9]+){1,3})\)/)?.[1] ?? null;
}

export function countWebViewSockets(output) {
  return new Set([...output.matchAll(/@webview_devtools_remote(?:_[0-9]+)?(?=\s|$)/g)]
    .map((match) => match[0])).size;
}

export async function diagnose({
  adb = 'adb', serial, executeAdb = runAdb,
  nodeVersion = process.versions.node, platform = process.platform, arch = process.arch,
} = {}) {
  const checks = [];
  const add = (id, status, code, message, details) => {
    checks.push({ id, status, code, message, ...(details ? { details } : {}) });
  };
  const finish = () => ({
    schemaVersion: 1,
    scope: '仅检查开发环境与设备前置条件，不代表目标 APP、投屏、输入或 DevTools 已通过验收。',
    ready: checks.every((check) => check.status !== 'blocked'),
    checks,
  });
  const [major, minor] = nodeVersion.split('.').map(Number);
  const supportedNode = major > 22 || (major === 22 && minor >= 12);
  add('node', supportedNode ? 'pass' : 'blocked', supportedNode ? 'node_ready' : 'node_unsupported',
    supportedNode ? 'Node.js 满足工程预检基线。' : '请使用 Node.js 22.12 或更高版本。');
  add('host', platform === 'win32' && arch === 'x64' ? 'pass' : 'warning',
    platform === 'win32' && arch === 'x64' ? 'host_ready' : 'host_not_release_target',
    '首发验证目标为 Windows x64；其他平台不代表安装包兼容性。');

  const version = await executeAdb(adb, ['version']);
  if (!version.ok) {
    add('adb', 'blocked', `adb_${version.code}`,
      '无法运行 ADB。请安装官方 Platform Tools，加入 PATH 或使用 --adb 指定 adb.exe。');
    return finish();
  }
  const adbVersion = version.stdout.match(/Android Debug Bridge version ([0-9.]+)/)?.[1];
  if (!adbVersion) {
    add('adb', 'blocked', 'adb_invalid_version', 'ADB 版本响应无法识别。');
    return finish();
  }
  add('adb', 'pass', 'adb_ready', 'ADB 可用。', { version: adbVersion });

  const response = await executeAdb(adb, ['devices', '-l']);
  const devices = response.ok ? parseDevices(response.stdout) : null;
  if (!devices) {
    add('device', 'blocked', 'device_list_failed', '无法读取设备列表，请检查 ADB 服务。');
    return finish();
  }
  const selected = serial ? devices.filter((device) => device.serial === serial) : devices;
  if (selected.length !== 1) {
    const code = selected.length > 1 ? 'device_selection_required'
      : serial ? 'selected_device_missing' : 'no_device';
    add('device', 'blocked', code, selected.length > 1
      ? '发现多台设备，请用 --serial 明确选择；不会擅自连接其中一台。'
      : '未找到所选设备，请通过 USB 连接手机并开启 USB 调试。', { count: devices.length });
    return finish();
  }
  const device = selected[0];
  if (device.state !== 'device') {
    const messages = {
      unauthorized: '等待授权，请解锁手机并确认 USB 调试授权。',
      offline: '设备离线，请检查 USB 连接。',
      no_permissions: 'ADB 没有设备访问权限，请检查驱动或 USB 权限。',
    };
    const knownState = Object.hasOwn(messages, device.state);
    add('device', 'blocked', knownState ? `device_${device.state}` : 'device_not_ready',
      knownState ? messages[device.state] : '设备不在可调试状态。');
    return finish();
  }
  const prefix = ['-s', device.serial];
  const transport = await executeAdb(adb, [...prefix, 'get-devpath']);
  let usbConfirmed = transport.ok && transport.stdout.trim().startsWith('usb:');
  if (!usbConfirmed) {
    // Windows/libusb 可能不提供设备路径，使用 ADB 的 USB 专用选择器交叉确认。
    // 多 USB 设备时 -d 会失败；不能因此退回到任意设备或猜测连接类型。
    const usb = await executeAdb(adb, ['-d', 'get-serialno']);
    usbConfirmed = usb.ok && usb.stdout.trim() === device.serial;
  }
  if (!usbConfirmed) {
    add('device', 'blocked', 'usb_transport_unverified',
      '未确认所选设备的 USB 传输。若连接了多台 USB 设备且 ADB 不提供设备路径，请仅保留待验收设备。');
    return finish();
  }
  add('device', 'pass', 'usb_device_ready', '已确认一台已授权的 USB 设备。');

  const commands = [
    ['shell', 'getprop', 'ro.build.version.release'],
    ['shell', 'getprop', 'ro.build.version.sdk'],
    ['shell', 'dumpsys', 'webviewupdate'],
    ['shell', 'cat', '/proc/net/unix'],
  ];
  const [release, sdk, webview, sockets] = await Promise.all(
    commands.map((args) => executeAdb(adb, [...prefix, ...args])),
  );
  const androidVersion = release.ok && /^[0-9]+(?:\.[0-9]+){0,3}$/.test(release.stdout.trim())
    ? release.stdout.trim() : null;
  const apiLevel = sdk.ok && /^[0-9]{1,3}$/.test(sdk.stdout.trim()) ? Number(sdk.stdout.trim()) : null;
  add('android', androidVersion && apiLevel ? 'pass' : 'blocked',
    androidVersion && apiLevel ? 'android_version_detected' : 'android_version_unavailable',
    'Android 版本仅供后续兼容性验证，不作全功能支持承诺。', { version: androidVersion, apiLevel });
  const webviewVersion = webview.ok ? parseWebViewVersion(webview.stdout) : null;
  add('webview', webviewVersion ? 'pass' : 'blocked',
    webviewVersion ? 'webview_provider_detected' : 'webview_provider_unavailable',
    webviewVersion ? '已读取系统 WebView 提供程序版本；目标 APP 实际内核仍需 CDP 核实。'
      : '无法确定系统 WebView 提供程序，请检查安装状态或设备权限。',
    webviewVersion ? { version: webviewVersion } : undefined);
  const count = sockets.ok ? countWebViewSockets(sockets.stdout) : 0;
  add('sockets', sockets.ok && count > 0 ? 'pass' : 'blocked',
    !sockets.ok ? 'socket_list_unavailable' : count ? 'webview_socket_detected' : 'no_webview_socket',
    count ? '检测到 WebView 调试 socket；尚未关联目标 APP 或验证页面可见性。'
      : '未确认可调试 WebView，请打开目标 APP 的 WebView 并确保已启用调试。', { count });
  return finish();
}