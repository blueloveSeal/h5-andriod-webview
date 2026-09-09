import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { diagnose } from './lib/doctor.mjs';

export function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--help') {
      options.help = true;
      continue;
    }
    if (flag !== '--adb' && flag !== '--serial') throw new Error('invalid_arguments');
    const key = flag.slice(2);
    const value = args[++index];
    if (!value?.trim() || value.startsWith('--') || Object.hasOwn(options, key)) {
      throw new Error('invalid_arguments');
    }
    options[key] = value;
  }
  return options;
}

export async function main(args) {
  let options;
  try {
    options = parseOptions(args);
  } catch {
    console.error('参数无效。使用 node scripts/doctor.mjs --help 查看说明。');
    return 2;
  }
  if (options.help) {
    console.log([
      'Android WebView 工作台：环境与设备预检（不需要第三方依赖）',
      '用法：node scripts/doctor.mjs [--adb <adb.exe 路径>] [--serial <设备序列号>]',
      '默认使用 PATH 中的 ADB；多设备时必须明确选择。',
      '输出 JSON，不记录序列号、页面 URL、设备原始输出或认证数据。',
      'ADB 枚举可能启动共用 ADB Server；本工具不会关闭它，也不会创建转发或操作 APP。',
      '退出码：0 前置条件满足；1 存在阻塞；2 参数或工具内部错误。',
      '注意：预检成功不代表投屏、输入、DevTools 或目标 APP 已通过验收。',
      '下一步：node scripts/webview.mjs --help 查看页面发现与 DevTools 连接（会创建临时转发）。',
    ].join('\n'));
    return 0;
  }
  try {
    const report = await diagnose(options);
    console.log(JSON.stringify(report, null, 2));
    return report.ready ? 0 : 1;
  } catch {
    console.error('预检异常终止；为保护设备数据，不输出原始异常。');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}