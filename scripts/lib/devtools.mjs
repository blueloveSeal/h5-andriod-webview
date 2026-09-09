import { get } from 'node:http';

const messages = Object.freeze({
  invalid_arguments: 'DevTools 参数无效。',
  aborted: '操作已取消。',
  http_failed: '无法读取本机 DevTools 接口。',
  http_timeout: '读取 DevTools 接口超时。',
  response_too_large: 'DevTools 响应超过大小限制。',
  invalid_json: 'DevTools 接口未返回有效 JSON。',
  cdp_unavailable: '当前 Node.js 不提供 WebSocket，请使用 Node.js 22.12 或更高版本。',
  cdp_connect_failed: '无法连接所选页面的 CDP 接口。',
  cdp_timeout: 'CDP 操作超时。',
  cdp_closed: 'CDP 连接已关闭。',
  cdp_invalid_message: 'CDP 返回了不支持的消息。',
  cdp_command_failed: 'CDP 命令未成功执行。',
  cdp_pending_limit: 'CDP 并发请求超过限制。',
  devtools_failed: 'DevTools 操作失败。',
});

export class DevToolsError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(messages, code) ? code : 'devtools_failed';
    super(messages[safeCode]);
    this.name = 'DevToolsError';
    this.code = safeCode;
  }
}

const validPort = (port) => Number.isInteger(port) && port >= 1 && port <= 65535;
const validTimeout = (value) => Number.isInteger(value) && value >= 1 && value <= 60_000;
const validSize = (value) => Number.isInteger(value) && value >= 1 && value <= 8 * 1024 * 1024;
const validSignal = (signal) => signal === undefined || signal instanceof AbortSignal;
const plainObject = (value) => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

// 不使用代理、不跟随重定向；地址、端口和接口路径均由本工具确定。
export async function readDevToolsJson(port, pathname, {
  signal, timeoutMs = 5000, maxBytes = 1024 * 1024,
} = {}) {
  if (!validPort(port) || !['/json/list', '/json/version'].includes(pathname)
    || !validTimeout(timeoutMs) || !validSize(maxBytes) || !validSignal(signal)) {
    throw new DevToolsError('invalid_arguments');
  }
  if (signal?.aborted) throw new DevToolsError('aborted');
  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        request?.destroy();
        reject(error);
      } else resolve(value);
    };
    const onAbort = () => finish(new DevToolsError('aborted'));
    // 总时限覆盖整个响应，不能靠持续发送少量数据绕过。
    const timer = setTimeout(() => finish(new DevToolsError('http_timeout')), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      request = get({ hostname: '127.0.0.1', port, path: pathname, agent: false,
        headers: { Accept: 'application/json' } }, (response) => {
        response.once('error', () => finish(new DevToolsError('http_failed')));
        response.once('aborted', () => finish(new DevToolsError('http_failed')));
        if (response.statusCode !== 200) {
          finish(new DevToolsError('http_failed'));
          return;
        }
        let size = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > maxBytes) finish(new DevToolsError('response_too_large'));
          else chunks.push(chunk);
        });
        response.once('end', () => {
          if (settled) return;
          try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { finish(new DevToolsError('invalid_json')); }
        });
      });
      request.once('error', () => finish(new DevToolsError('http_failed')));
    } catch {
      finish(new DevToolsError('http_failed'));
    }
  });
}

export async function connectCdp(url, {
  signal, timeoutMs = 5000, maxMessageBytes = 1024 * 1024, webSocketFactory,
} = {}) {
  // 校验原字符串，拒绝 URL 规范化、认证字段、外部主机、查询参数和片段。
  const match = typeof url === 'string'
    && /^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/devtools\/page\/[A-Za-z0-9_-]{1,128}$/.exec(url);
  if (!match || !validPort(Number(match[1])) || !validTimeout(timeoutMs)
    || !validSize(maxMessageBytes) || !validSignal(signal)
    || (webSocketFactory !== undefined && typeof webSocketFactory !== 'function')) {
    throw new DevToolsError('invalid_arguments');
  }
  if (signal?.aborted) throw new DevToolsError('aborted');
  if (!webSocketFactory && typeof globalThis.WebSocket !== 'function') {
    throw new DevToolsError('cdp_unavailable');
  }
  let socket;
  try {
    socket = (webSocketFactory ?? ((address) => new globalThis.WebSocket(address)))(url);
    if (!['addEventListener', 'removeEventListener', 'send', 'close']
      .every((key) => typeof socket?.[key] === 'function')) throw new Error();
  } catch {
    throw new DevToolsError('cdp_connect_failed');
  }
  return new Promise((resolve, reject) => {
    let opened = false;
    let stopped = false;
    let nextId = 0;
    const pending = new Map();
    const finishRequest = (id, error, result) => {
      const item = pending.get(id);
      if (!item) return;
      pending.delete(id);
      clearTimeout(item.timer);
      item.signal?.removeEventListener('abort', item.onAbort);
      if (error) item.reject(error);
      else item.resolve(result);
    };
    const stop = (code) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(handshakeTimer);
      signal?.removeEventListener('abort', onAbort);
      for (const [name, handler] of Object.entries(handlers)) socket.removeEventListener(name, handler);
      for (const id of pending.keys()) finishRequest(id, new DevToolsError(code));
      if (!opened) reject(new DevToolsError(code));
      // 原生 WebSocket 没有 terminate；不依赖私有实现，也不等待无限长的关闭握手。
      try { socket.close(); } catch { /* 不输出底层异常。 */ }
    };
    const onAbort = () => stop('aborted');
    const client = Object.freeze({
      async request(method, params = {}, { timeoutMs: requestTimeout = 5000, signal: requestSignal } = {}) {
        if (stopped || !opened) throw new DevToolsError('cdp_closed');
        if (typeof method !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}\.[A-Za-z][A-Za-z0-9]{0,63}$/.test(method)
          || !plainObject(params) || !validTimeout(requestTimeout) || !validSignal(requestSignal)) {
          throw new DevToolsError('invalid_arguments');
        }
        if (requestSignal?.aborted) throw new DevToolsError('aborted');
        if (pending.size >= 64 || nextId >= Number.MAX_SAFE_INTEGER) {
          throw new DevToolsError('cdp_pending_limit');
        }
        const id = ++nextId;
        let payload;
        try { payload = JSON.stringify({ id, method, params }); }
        catch { throw new DevToolsError('invalid_arguments'); }
        if (Buffer.byteLength(payload) > maxMessageBytes) throw new DevToolsError('response_too_large');
        return new Promise((requestResolve, requestReject) => {
          const abort = () => finishRequest(id, new DevToolsError('aborted'));
          const timer = setTimeout(() => finishRequest(id, new DevToolsError('cdp_timeout')), requestTimeout);
          pending.set(id, { resolve: requestResolve, reject: requestReject, timer,
            signal: requestSignal, onAbort: abort });
          requestSignal?.addEventListener('abort', abort, { once: true });
          try { socket.send(payload); }
          catch { stop('cdp_closed'); }
        });
      },
      async close() { stop('cdp_closed'); },
    });
    const handlers = {
      open: () => {
        if (stopped || opened) return;
        opened = true;
        clearTimeout(handshakeTimer);
        resolve(client);
      },
      error: () => stop(opened ? 'cdp_closed' : 'cdp_connect_failed'),
      close: () => stop(opened ? 'cdp_closed' : 'cdp_connect_failed'),
      message: (event) => {
        if (stopped) return;
        if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > maxMessageBytes) {
          stop('cdp_invalid_message');
          return;
        }
        let message;
        try { message = JSON.parse(event.data); }
        catch { stop('cdp_invalid_message'); return; }
        if (!plainObject(message)) { stop('cdp_invalid_message'); return; }
        if (!Object.hasOwn(message, 'id')) {
          // 通知可能包含 URL、认证数据或页面内容；直接丢弃，不记录、不转发。
          if (typeof message.method !== 'string') stop('cdp_invalid_message');
          return;
        }
        if (!Number.isSafeInteger(message.id) || message.id < 1) {
          stop('cdp_invalid_message');
          return;
        }
        if (!pending.has(message.id)) return; // 已超时的响应不能命中新请求。
        const hasResult = Object.hasOwn(message, 'result');
        const hasError = Object.hasOwn(message, 'error');
        if (hasResult === hasError || (hasResult && !plainObject(message.result))) {
          stop('cdp_invalid_message');
          return;
        }
        finishRequest(message.id, hasError ? new DevToolsError('cdp_command_failed') : null, message.result);
      },
    };
    const handshakeTimer = setTimeout(() => stop('cdp_timeout'), timeoutMs);
    for (const [name, handler] of Object.entries(handlers)) socket.addEventListener(name, handler);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else if (socket.readyState === 1) handlers.open();
    else if (socket.readyState > 1) handlers.close();
  });
}
