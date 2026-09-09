import { createHash } from 'node:crypto';
import { parseWebViewSockets, runAdb, selectUsbDevice } from './doctor.mjs';
import { connectCdp, DevToolsError, readDevToolsJson } from './devtools.mjs';

const messages = Object.freeze({
  invalid_arguments: '参数无效，请指定有效的 APP 包名。',
  aborted: '操作已取消。',
  device_list_failed: '无法读取设备列表，请检查 ADB 服务。',
  device_selection_required: '发现多台设备，请用 --serial 明确选择。',
  selected_device_missing: '所选设备已消失，不会回退到其他设备。',
  no_device: '没有发现设备，请通过 USB 连接手机。',
  device_unauthorized: '请解锁手机并确认 USB 调试授权。',
  device_offline: '设备离线，请检查 USB 连接。',
  device_no_permissions: 'ADB 没有设备访问权限。',
  device_not_ready: '设备不在可调试状态。',
  usb_transport_unverified: '未确认所选设备的 USB 传输，请检查连接或只保留待调试设备。',
  processes_unavailable: '无法读取 APP 进程，请确认设备支持 ps -A -o PID,NAME。',
  app_not_running: '未找到指定 APP 的进程，请先手动打开 APP。',
  socket_list_unavailable: '无法读取设备的调试 socket。',
  socket_owner_unverified: '发现无 PID 的 WebView socket，无法安全关联指定 APP。',
  no_webview_socket: '未找到属于指定 APP 的 WebView 调试 socket，请打开 WebView 并启用调试。',
  too_many_webviews: 'WebView 数量超过单次会话限制，请关闭不需要的页面后重试。',
  forward_unverified: '无法确认新建转发的状态；不会猜测端口或删除其他转发。',
  forward_changed: '调试转发已消失或被替换，请重新发现页面。',
  endpoint_unavailable: '部分 WebView 接口不可读，页面列表可能不完整。',
  invalid_targets: '部分 WebView 返回了不支持的页面列表。',
  endpoint_rejected: '部分页面的调试地址不属于当前本机转发，已拒绝连接。',
  no_inspectable_pages: '未发现可连接的 page 类型页面。',
  target_selection_required: '页面不唯一或发现结果不完整，请用 --target 明确选择页面 ID。',
  target_missing: '所选页面已消失，不会回退连接其他页面。',
  target_not_inspectable: '所选页面未提供可接受的调试接口。',
  target_changed: '所选页面所属 APP 进程已变化，请重新发现页面。',
  invalid_cdp_version: 'CDP 版本响应无法验证。',
  session_closed: '调试会话已关闭。',
  session_busy: '已有页面连接校验正在进行。',
  webview_failed: 'WebView 操作失败；为保护设备数据，不输出原始异常。',
});

export class WebViewError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(messages, code) ? code : 'webview_failed';
    super(messages[safeCode]);
    this.name = 'WebViewError';
    this.code = safeCode;
  }
}

export const isPackageName = (value) => typeof value === 'string' && value.length <= 255
  && /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(value);
export const isTargetId = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const validSerial = (value) => value === undefined || (typeof value === 'string'
  && value.length > 0 && value.length <= 256 && !value.startsWith('-') && !/[\s\x00-\x1f\x7f]/.test(value));
const validPort = (value) => /^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 65535;
const processCommand = ['shell', 'ps', '-A', '-o', 'PID,NAME'];

export function parseAppProcessIds(output, packageName) {
  if (typeof output !== 'string' || !isPackageName(packageName)) return null;
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!/^PID\s+NAME$/.test(lines.shift() ?? '')) return null;
  const processes = new Map();
  for (const line of lines) {
    const match = /^([1-9][0-9]{0,9})\s+(.+)$/.exec(line);
    if (!match || Number(match[1]) > 2147483647) return null;
    if (processes.has(match[1]) && processes.get(match[1]) !== match[2]) return null;
    processes.set(match[1], match[2]);
  }
  return new Set([...processes].filter(([, name]) => name === packageName
    || (name.startsWith(`${packageName}:`) && name.length > packageName.length + 1))
    .map(([pid]) => pid));
}

function parseForwards(output) {
  const result = [];
  for (const line of output.split(/\r?\n/).filter((value) => value.trim())) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3) return null;
    result.push({ serial: fields[0], local: fields[1], remote: fields[2] });
  }
  return result;
}

function pageMetadata(description) {
  let value = {};
  if (typeof description === 'string' && description.length <= 4096) {
    try { value = JSON.parse(description) ?? {}; } catch { /* 描述为可选字段。 */ }
  }
  const dimension = (number) => Number.isInteger(number) && number >= 0 && number <= 32768 ? number : null;
  return {
    visible: typeof value.visible === 'boolean' ? value.visible : null,
    attachedToWindow: typeof value.attached === 'boolean' ? value.attached : null,
    width: dimension(value.width), height: dimension(value.height),
  };
}

function readPages(payload, forward, deviceSerial, packageName) {
  if (!Array.isArray(payload) || payload.length > 256) throw new WebViewError('invalid_targets');
  const pages = [];
  const seen = new Set();
  for (const target of payload) {
    if (!target || typeof target !== 'object' || typeof target.type !== 'string') {
      throw new WebViewError('invalid_targets');
    }
    if (target.type !== 'page') continue;
    if (typeof target.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(target.id) || seen.has(target.id)) {
      throw new WebViewError('invalid_targets');
    }
    seen.add(target.id);
    const endpoint = `ws://127.0.0.1:${forward.port}/devtools/page/${target.id}`;
    const accepted = [endpoint, endpoint.replace('127.0.0.1', 'localhost'), endpoint.replace('127.0.0.1', '[::1]')];
    const inspectable = accepted.includes(target.webSocketDebuggerUrl);
    const id = createHash('sha256').update(JSON.stringify([
      deviceSerial, packageName, forward.socket, target.id,
    ])).digest('hex').slice(0, 32);
    pages.push({ id, remoteId: target.id, endpoint, forward, inspectable,
      rejectedEndpoint: target.webSocketDebuggerUrl !== undefined && !inspectable,
      metadata: pageMetadata(target.description) });
  }
  return pages;
}

// 只暴露安全摘要；设备标识、页面 URL/标题、原始 CDP 字段留在作用域内。
export async function discoverWebViews({
  adb = 'adb', serial, packageName, signal, executeAdb = runAdb,
  readJson = readDevToolsJson, connect = connectCdp,
} = {}) {
  if (!isPackageName(packageName) || !validSerial(serial) || typeof adb !== 'string'
    || !adb.trim() || /[\x00-\x1f\x7f]/.test(adb)
    || ![executeAdb, readJson, connect].every((value) => typeof value === 'function')
    || (signal !== undefined && !(signal instanceof AbortSignal))) {
    throw new WebViewError('invalid_arguments');
  }
  let deviceSerial;
  let closed = false;
  let closePromise;
  let probePromise;
  let uncertainForward = false;
  const owned = [];
  const pages = [];
  const warnings = [];
  const check = () => {
    if (signal?.aborted) throw new WebViewError('aborted');
    if (closed) throw new WebViewError('session_closed');
  };
  const call = async (args, cleaning = false) => {
    if (!cleaning) check();
    try {
      const response = await executeAdb(adb, args);
      return response?.ok === true && typeof response.stdout === 'string'
        ? { ok: true, stdout: response.stdout } : { ok: false };
    } catch {
      return { ok: false };
    }
  };
  const prefix = () => ['-s', deviceSerial];
  const addWarning = (code) => {
    if (!warnings.some((warning) => warning.code === code)) {
      warnings.push(Object.freeze({ code, message: messages[code] }));
    }
  };
  const mappingFor = async (forward, cleaning = false) => {
    const result = await call([...prefix(), 'forward', '--list'], cleaning);
    const mappings = result.ok ? parseForwards(result.stdout) : null;
    if (!mappings) return 'unknown';
    const matches = mappings.filter((entry) => entry.local === `tcp:${forward.port}`);
    if (!matches.length) return 'absent';
    return matches.length === 1 && matches[0].serial === deviceSerial
      && matches[0].remote === `localabstract:${forward.socket}` ? 'owned' : 'replaced';
  };
  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      if (probePromise) await probePromise.catch(() => {});
      let failed = uncertainForward ? 1 : 0;
      let removed = 0;
      let preserved = 0;
      for (const forward of owned) {
        // 每次删除前核对所有权；不使用 remove-all，不关闭共用 ADB Server。
        const state = await mappingFor(forward, true);
        if (state === 'unknown') { failed += 1; continue; }
        if (state === 'replaced') { preserved += 1; continue; }
        if (state === 'absent') continue;
        const result = await call([...prefix(), 'forward', '--remove', `tcp:${forward.port}`], true);
        if (result.ok) removed += 1;
        else failed += 1;
      }
      return Object.freeze({ ok: failed === 0, code: failed ? 'cleanup_incomplete' : 'cleanup_complete',
        removed, preserved, uncertainForward });
    })();
    return closePromise;
  };
  const choosePage = (targetId) => {
    if (targetId !== undefined && !isTargetId(targetId)) throw new WebViewError('invalid_arguments');
    if (targetId !== undefined) {
      const page = pages.find((candidate) => candidate.id === targetId);
      if (!page) throw new WebViewError('target_missing');
      if (!page.inspectable) throw new WebViewError('target_not_inspectable');
      return page;
    }
    const available = pages.filter((page) => page.inspectable);
    if (!available.length) throw new WebViewError('no_inspectable_pages');
    if (available.length !== 1 || warnings.length) throw new WebViewError('target_selection_required');
    return available[0];
  };
  const verify = async (targetId) => {
    check();
    if (probePromise) throw new WebViewError('session_busy');
    const page = choosePage(targetId);
    probePromise = (async () => {
      const processes = await call([...prefix(), ...processCommand]);
      const pids = processes.ok ? parseAppProcessIds(processes.stdout, packageName) : null;
      if (!pids?.has(page.forward.pid)) throw new WebViewError('target_changed');
      if (await mappingFor(page.forward) !== 'owned') throw new WebViewError('forward_changed');
      check();
      const current = readPages(await readJson(page.forward.port, '/json/list', { signal }),
        page.forward, deviceSerial, packageName).find((candidate) => candidate.remoteId === page.remoteId);
      if (!current) throw new WebViewError('target_missing');
      if (!current.inspectable) throw new WebViewError('target_not_inspectable');
      check();
      let client;
      try {
        client = await connect(page.endpoint, { signal });
        const version = await client.request('Browser.getVersion', {}, { signal });
        check();
        const protocolVersion = typeof version?.protocolVersion === 'string'
          && /^[0-9]{1,3}\.[0-9]{1,3}$/.test(version.protocolVersion) ? version.protocolVersion : null;
        const browserVersion = typeof version?.product === 'string'
          ? /^(?:Chrome|HeadlessChrome|Chromium)\/([0-9]+(?:\.[0-9]+){1,3})$/.exec(version.product)?.[1] : null;
        if (!protocolVersion || !browserVersion) throw new WebViewError('invalid_cdp_version');
        return Object.freeze({ target: page.id, protocolVersion, browserVersion,
          forwardingAddress: `127.0.0.1:${page.forward.port}`,
          devtoolsFrontendUrl: `devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${page.forward.port}/devtools/page/${page.remoteId}` });
      } finally {
        // 释放探测连接，避免与用户随后打开的 DevTools 前端抢占会话。
        if (client) await client.close();
      }
    })();
    try { return await probePromise; }
    catch (error) {
      throw error instanceof WebViewError || error instanceof DevToolsError
        ? error : new WebViewError('webview_failed');
    } finally { probePromise = undefined; }
  };
  try {
    check();
    const selection = await selectUsbDevice({ adb, serial, executeAdb: (_file, args) => call(args) });
    if (!selection.ok) throw new WebViewError(selection.code);
    deviceSerial = selection.device.serial;
    check();
    const [processes, sockets] = await Promise.all([
      call([...prefix(), ...processCommand]), call([...prefix(), 'shell', 'cat', '/proc/net/unix']),
    ]);
    const pids = processes.ok ? parseAppProcessIds(processes.stdout, packageName) : null;
    if (!pids) throw new WebViewError('processes_unavailable');
    if (!pids.size) throw new WebViewError('app_not_running');
    if (!sockets.ok) throw new WebViewError('socket_list_unavailable');
    const names = parseWebViewSockets(sockets.stdout);
    const matched = names.filter((name) => pids.has(name.slice('webview_devtools_remote_'.length)));
    if (!matched.length) throw new WebViewError(names.includes('webview_devtools_remote')
      ? 'socket_owner_unverified' : 'no_webview_socket');
    if (matched.length > 16) throw new WebViewError('too_many_webviews');
    for (const socket of matched) {
      const result = await call([...prefix(), 'forward', '--no-rebind', 'tcp:0', `localabstract:${socket}`]);
      const value = result.ok ? result.stdout.trim() : '';
      if (!validPort(value)) {
        uncertainForward = true;
        throw new WebViewError('forward_unverified');
      }
      const forward = { socket, port: Number(value), pid: socket.slice('webview_devtools_remote_'.length) };
      // 必须先登记端口再检查取消，确保刚创建的资源也能被清理。
      owned.push(forward);
      check();
      if (await mappingFor(forward) !== 'owned') throw new WebViewError('forward_changed');
      try {
        const found = readPages(await readJson(forward.port, '/json/list', { signal }), forward, deviceSerial, packageName);
        if (found.some((page) => page.rejectedEndpoint)) addWarning('endpoint_rejected');
        pages.push(...found);
      } catch (error) {
        check();
        addWarning(error instanceof WebViewError ? 'invalid_targets' : 'endpoint_unavailable');
      }
      if (pages.length > 256) throw new WebViewError('too_many_webviews');
    }
    check();
    pages.sort((first, second) => first.id.localeCompare(second.id));
    return Object.freeze({
      targets: Object.freeze(pages.map((page) => Object.freeze({ id: page.id, type: 'page',
        inspectable: page.inspectable, ...page.metadata }))),
      warnings: Object.freeze(warnings), complete: warnings.length === 0, verify, close,
    });
  } catch (error) {
    const safe = error instanceof WebViewError || error instanceof DevToolsError
      ? error : new WebViewError('webview_failed');
    safe.cleanup = await close();
    throw safe;
  }
}
