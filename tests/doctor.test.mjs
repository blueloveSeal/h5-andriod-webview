import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseOptions } from '../scripts/doctor.mjs';
import { countWebViewSockets, diagnose, parseDevices, parseWebViewVersion, runAdb } from '../scripts/lib/doctor.mjs';

const ok = (stdout) => ({ ok: true, stdout });
const baseline = { platform: 'win32', arch: 'x64', nodeVersion: '22.18.0' };
const provider = 'Current WebView package (name, version): (com.google.android.webview, 139.0.7258.143)';

function fakeAdb(overrides = {}) {
  const calls = [];
  const replies = {
    version: ok('Android Debug Bridge version 1.0.41\nVersion 36.0.0-13206524'),
    'devices -l': ok('List of devices attached\r\nfixture-device device product:test transport_id:1\r\n'),
    'get-devpath': ok('usb:1-2\n'),
    '-d get-serialno': { ok: false, code: 'command_failed' },
    'shell getprop ro.build.version.release': ok('15\n'),
    'shell getprop ro.build.version.sdk': ok('35\n'),
    'shell dumpsys webviewupdate': ok(provider),
    'shell cat /proc/net/unix': ok('0000: 0000 0000 00010000 0001 01 123 @webview_devtools_remote_456\n'),
    ...overrides,
  };
  const executeAdb = async (file, args) => {
    calls.push({ file, args });
    const key = (args[0] === '-s' ? args.slice(2) : args).join(' ');
    assert.ok(Object.hasOwn(replies, key), `Unexpected ADB command: ${key}`);
    return replies[key];
  };
  return { executeAdb, calls };
}

test('解析设备列表，保留授权、离线、权限和未知状态', () => {
  assert.deepEqual(parseDevices('* daemon started successfully\nList of devices attached\n'
    + 'one device model:test\ntwo unauthorized\nthree offline\nfour no permissions\nfive recovery\n'), [
    { serial: 'one', state: 'device' }, { serial: 'two', state: 'unauthorized' },
    { serial: 'three', state: 'offline' }, { serial: 'four', state: 'no_permissions' },
    { serial: 'five', state: 'recovery' },
  ]);
  assert.equal(parseDevices('unexpected response'), null);
  assert.deepEqual(parseDevices('List of devices attached\r\n\r\n'), []);
});

test('WebView 仅取当前提供程序版本，不误取历史或候选版本', () => {
  assert.equal(parseWebViewVersion(provider), '139.0.7258.143');
  assert.equal(parseWebViewVersion('Valid package com.android.webview (versionName: 138.0.0.0)'), null);
  assert.equal(parseWebViewVersion('Current WebView package is null'), null);
});

test('调试 socket 去重并排除其他应用 socket 与无效后缀', () => {
  assert.equal(countWebViewSockets('@webview_devtools_remote_1\n@webview_devtools_remote_1\n'
    + '@webview_devtools_remote_2\n@webview_devtools_remote\n@chrome_devtools_remote\n'
    + '@webview_devtools_remote_2_other\n'), 3);
});

test('USB 真机前置条件满足时成功，报告不包含设备标识或原始输出', async () => {
  const fake = fakeAdb();
  const result = await diagnose({ ...baseline, ...fake, adb: 'C:/Platform Tools/adb.exe' });
  assert.equal(result.ready, true);
  assert.equal(result.checks.length, 7);
  assert.ok(result.checks.every((check) => check.status === 'pass'));
  assert.equal(JSON.stringify(result).includes('fixture-device'), false);
  assert.equal(JSON.stringify(result).includes('@webview'), false);
  assert.ok(fake.calls.every((call) => call.file === 'C:/Platform Tools/adb.exe'));
  assert.ok(fake.calls.slice(2).every((call) => call.args[1] === 'fixture-device'));
});

for (const state of ['unauthorized', 'offline', 'no permissions', 'recovery']) {
  test(`设备状态 ${state} 时阻止 shell 操作`, async () => {
    const fake = fakeAdb({ 'devices -l': ok(`List of devices attached\none ${state}\n`) });
    const result = await diagnose({ ...baseline, ...fake });
    assert.equal(result.ready, false);
    assert.equal(fake.calls.length, 2);
  });
}

for (const code of ['not_found', 'timeout', 'command_failed']) {
  test(`ADB ${code} 失败时提供安全的诊断`, async () => {
    const fake = fakeAdb({ version: { ok: false, code } });
    const result = await diagnose({ ...baseline, ...fake });
    assert.equal(result.ready, false);
    assert.equal(result.checks.at(-1).code, `adb_${code}`);
    assert.equal(fake.calls.length, 1);
  });
}

test('空设备列表与畸形响应不能被当作成功', async () => {
  for (const [response, code] of [
    [ok('List of devices attached\n'), 'no_device'],
    [ok('malformed'), 'device_list_failed'],
    [{ ok: false, code: 'timeout' }, 'device_list_failed'],
  ]) {
    const result = await diagnose({ ...baseline, ...fakeAdb({ 'devices -l': response }) });
    assert.equal(result.ready, false);
    assert.equal(result.checks.at(-1).code, code);
  }
});

test('多设备必须选择；指定设备消失时不能回退连接另一台', async () => {
  const devices = ok('List of devices attached\none device\ntwo device\n');
  for (const [serial, code] of [[undefined, 'device_selection_required'], ['missing', 'selected_device_missing']]) {
    const fake = fakeAdb({ 'devices -l': devices });
    const result = await diagnose({ ...baseline, ...fake, serial });
    assert.equal(result.checks.at(-1).code, code);
    assert.equal(fake.calls.length, 2);
  }
  const fake = fakeAdb({ 'devices -l': devices });
  assert.equal((await diagnose({ ...baseline, ...fake, serial: 'two' })).ready, true);
  assert.ok(fake.calls.slice(2).every((call) => call.args[1] === 'two'));
});

test('网络设备和模拟器不能被当作 USB 真机', async () => {
  for (const stdout of ['localhost:5555', 'emulator-5554', 'unknown']) {
    const fake = fakeAdb({ 'get-devpath': ok(stdout) });
    const result = await diagnose({ ...baseline, ...fake });
    assert.equal(result.checks.at(-1).code, 'usb_transport_unverified');
    assert.equal(fake.calls.length, 4);
  }
});

test('Windows/libusb 未提供路径时，通过 USB 专用选择器匹配同一设备', async () => {
  const result = await diagnose({ ...baseline, ...fakeAdb({
    'get-devpath': ok('unknown'), '-d get-serialno': ok('fixture-device\n'),
  }) });
  assert.equal(result.ready, true);
  assert.equal(JSON.stringify(result).includes('fixture-device'), false);
});

test('USB 专用选择器找到另一台设备时，不把网络设备误认成 USB', async () => {
  const fake = fakeAdb({ 'get-devpath': ok('unknown'), '-d get-serialno': ok('other-device') });
  const result = await diagnose({ ...baseline, ...fake });
  assert.equal(result.checks.at(-1).code, 'usb_transport_unverified');
  assert.equal(fake.calls.length, 4);
});

test('属性、WebView 和 socket 不可读或格式未知时降级而非虚报成功', async () => {
  const result = await diagnose({ ...baseline, ...fakeAdb({
    'shell getprop ro.build.version.release': ok('unrecognized-private-output'),
    'shell getprop ro.build.version.sdk': { ok: false, code: 'timeout' },
    'shell dumpsys webviewupdate': ok('unrecognized-private-output'),
    'shell cat /proc/net/unix': { ok: false, code: 'command_failed' },
  }) });
  assert.equal(result.ready, false);
  assert.equal(JSON.stringify(result).includes('unrecognized-private-output'), false);
  assert.deepEqual(result.checks.slice(-3).map((check) => check.status), ['blocked', 'blocked', 'blocked']);
});

test('APP 尚未打开 WebView 时明确提示，而非宣称调试可用', async () => {
  const result = await diagnose({ ...baseline, ...fakeAdb({ 'shell cat /proc/net/unix': ok('') }) });
  assert.equal(result.ready, false);
  assert.equal(result.checks.at(-1).code, 'no_webview_socket');
});

test('不支持的 Node 版本阻塞；其他宿主平台给出兼容性警告', async () => {
  assert.equal((await diagnose({ ...baseline, ...fakeAdb(), nodeVersion: '22.11.0' })).ready, false);
  const result = await diagnose({ ...baseline, ...fakeAdb(), platform: 'linux' });
  assert.equal(result.checks[1].status, 'warning');
});

test('参数只接受已定义选项，支持带空格路径并拒绝重复或缺值', () => {
  assert.deepEqual(parseOptions(['--adb', 'C:/Android SDK/adb.exe', '--serial', 'two']),
    { adb: 'C:/Android SDK/adb.exe', serial: 'two' });
  for (const args of [['--adb'], ['--serial', '--help'], ['--adb', ''], ['--unknown'],
    ['--serial', 'one', '--serial', 'two']]) {
    assert.throws(() => parseOptions(args), /invalid_arguments/);
  }
});

test('真实子进程包装器对不存在的可执行文件返回受控错误', async () => {
  const missing = fileURLToPath(new URL('./nonexistent-adb-for-test.exe', import.meta.url));
  assert.deepEqual(await runAdb(missing, ['version']), { ok: false, code: 'not_found' });
});

test('CLI 帮助无需访问设备；无效参数返回退出码 2', async () => {
  const execute = promisify(execFile);
  const cli = fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url));
  const { stdout } = await execute(process.execPath, [cli, '--help']);
  assert.match(stdout, /退出码/);
  await assert.rejects(execute(process.execPath, [cli, '--unknown']), (error) => error.code === 2);
});