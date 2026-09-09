import { parseDevices, runAdb } from '../../scripts/lib/doctor.mjs';

/** @typedef {{ serial: string, state: string, model: string }} Device */
/** @typedef {{ devices: Device[], error: string | null }} DeviceList */

/** @returns {Promise<DeviceList>} */
export async function listDevices(adbPath = 'adb', execute = runAdb) {
  const result = await execute(adbPath, ['devices', '-l']);
  if (!result.ok) {
    return {
      devices: [],
      error: result.code === 'not_found'
        ? '未找到 ADB，请选择已安装的 adb.exe。'
        : result.code === 'timeout'
          ? 'ADB 响应超时，请检查 USB 连接后刷新。'
          : '暂时无法读取设备，请检查 ADB 后重试。',
    };
  }
  const parsed = parseDevices(result.stdout);
  if (!parsed) return { devices: [], error: 'ADB 返回的设备列表无法识别。' };
  const lines = result.stdout.split(/\r?\n/);
  return {
    devices: parsed.map((device) => {
      const line = lines.find((entry) => entry.trim().split(/\s+/)[0] === device.serial) ?? '';
      const model = line.match(/(?:^|\s)model:(\S+)/)?.[1]?.replaceAll('_', ' ') ?? 'Android 设备';
      return { ...device, model };
    }),
    error: null,
  };
}
