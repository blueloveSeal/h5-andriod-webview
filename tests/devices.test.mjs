import test from 'node:test';
import assert from 'node:assert/strict';
import { listDevices } from '../electron/services/devices.mjs';

test('保留设备授权状态并提取可读型号', async () => {
  const result = await listDevices('adb', async () => ({
    ok: true,
    stdout: 'List of devices attached\na device product:x model:Pixel_9 device:y\nb unauthorized\nc offline\n',
  }));
  assert.deepEqual(result.devices, [
    { serial: 'a', state: 'device', model: 'Pixel 9' },
    { serial: 'b', state: 'unauthorized', model: 'Android 设备' },
    { serial: 'c', state: 'offline', model: 'Android 设备' },
  ]);
  assert.equal(result.error, null);
});

test('ADB 缺失时提供可操作错误并清空设备', async () => {
  const result = await listDevices('missing', async () => ({ ok: false, code: 'not_found' }));
  assert.deepEqual(result.devices, []);
  assert.match(result.error, /adb.exe/);
});

test('异常格式不会冒充空设备列表', async () => {
  const result = await listDevices('adb', async () => ({ ok: true, stdout: 'unexpected output' }));
  assert.match(result.error, /无法识别/);
});

test('ADB 调用保持参数数组与指定路径', async () => {
  let actual;
  await listDevices('C:/tools/adb.exe', async (...args) => {
    actual = args;
    return { ok: true, stdout: 'List of devices attached\n' };
  });
  assert.deepEqual(actual, ['C:/tools/adb.exe', ['devices', '-l']]);
});
