import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';

/** @typedef {{ x: number, y: number, width: number, height: number }} Bounds */

export function inspectorUrl(endpoint, frontendEntry) {
  const target = new URL(endpoint);
  if (target.protocol !== 'ws:' || target.hostname !== '127.0.0.1' ||
      !/^\/cdp\/[0-9a-f]{64}$/.test(target.pathname) ||
      !/^\d+$/.test(target.port) || target.username || target.password || target.search || target.hash) {
    throw new Error('调试目标地址无效');
  }
  const frontend = new URL(frontendEntry);
  if (frontend.protocol !== 'http:' || frontend.hostname !== '127.0.0.1' || !/^\d+$/.test(frontend.port) ||
      !/^\/[0-9a-f]{40}\/inspector\.html$/.test(frontend.pathname) ||
      frontend.username || frontend.password || frontend.search || frontend.hash) {
    throw new Error('前端服务地址无效');
  }
  frontend.searchParams.set('ws', target.host + target.pathname);
  frontend.searchParams.set('panel', 'elements');
  return frontend.toString();
}

const diagnosticValue = (value, limit = 2048) => typeof value === 'string'
  ? value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, limit) || '未知'
  : '未知';

export function inspectorDiagnostics(target, electronChrome) {
  return [
    'WebView 工作台兼容诊断',
    'APP：' + diagnosticValue(target?.packageName, 256),
    '页面：' + diagnosticValue(target?.title, 512),
    'URL：' + diagnosticValue(target?.url),
    'WebView：' + diagnosticValue(target?.browser, 128),
    'CDP：' + diagnosticValue(target?.protocolVersion, 32),
    'WebKit：' + diagnosticValue(target?.webkitVersion, 128),
    'DevTools 前端修订：' + diagnosticValue(target?.frontendRevision, 40),
    '桌面 Chromium：' + diagnosticValue(electronChrome, 64),
  ].join('\n');
}

/** @param {{ fetcher?: (input: string, init?: RequestInit) => Promise<Response>, onRelayState?: (state: { endpoint: string, state: string, reason: string }) => void }} [options] */
export async function startInspectorFrontend({ fetcher = fetch, onRelayState = () => {} } = {}) {
  const revisions = new Set();
  const targets = new Map();
  const clients = new Set();
  const webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 });
  let baseUrl = '';

  function relayConnection(downstream, endpoint) {
    const upstream = new WebSocket(endpoint, { perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 });
    const pending = [];
    let pendingSize = 0;
    let ended = false;
    const relayState = (state, reason) => {
      if (state === 'closed' && ended) return;
      if (state === 'closed') ended = true;
      try { onRelayState({ endpoint, state, reason }); } catch {}
    };
    clients.add(downstream);
    clients.add(upstream);
    downstream.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else if (upstream.readyState === WebSocket.CONNECTING) {
        pendingSize += data.byteLength;
        if (pendingSize > 1024 * 1024) downstream.close(1009, 'Pending data is too large');
        else pending.push([data, isBinary]);
      }
    });
    upstream.on('open', () => {
      relayState('open', 'connected');
      for (const [data, isBinary] of pending) upstream.send(data, { binary: isBinary });
      pending.length = 0;
    });
    upstream.on('message', (data, isBinary) => {
      if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary: isBinary });
    });
    downstream.on('close', () => {
      clients.delete(downstream);
      relayState('closed', 'downstream-closed');
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
      else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    });
    upstream.on('close', () => {
      clients.delete(upstream);
      relayState('closed', 'upstream-closed');
      if (downstream.readyState === WebSocket.OPEN) downstream.close();
      else if (downstream.readyState === WebSocket.CONNECTING) downstream.terminate();
    });
    downstream.on('error', () => {
      relayState('closed', 'downstream-error');
      upstream.terminate();
    });
    upstream.on('error', () => {
      relayState('closed', 'upstream-error');
      downstream.close(1011, 'CDP connection failed');
    });
  }

  const server = http.createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    let requestPath = '/';
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      requestPath = url.pathname;
      const match = url.pathname.match(/^\/([0-9a-f]{40})\/([A-Za-z0-9._/-]+)$/);
      if (!match || !revisions.has(match[1]) || match[2].split('/').includes('..')) throw new Error('not found');
      // 查询串包含本机 CDP 地址，只在本机解析；上游仅收到固定修订号和静态资源路径。
      const remote = 'https://chrome-devtools-frontend.appspot.com/serve_rev/@' + match[1] + '/' + match[2];
      const upstream = await fetcher(remote, {
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: { 'Accept-Encoding': 'identity' },
      });
      const length = Number(upstream.headers.get('content-length') || 0);
      if (!upstream.ok || !upstream.body || length > 128 * 1024 * 1024) throw new Error('upstream failed');
      response.writeHead(200, {
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        ...(length ? { 'Content-Length': String(length) } : {}),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      if (request.method === 'HEAD') {
        await upstream.body.cancel();
        response.end();
      }
      else {
        const stream = Readable.fromWeb(upstream.body);
        let received = 0;
        stream.on('data', (chunk) => {
          received += chunk.length;
          if (received > 128 * 1024 * 1024) stream.destroy(new Error('resource too large'));
        });
        stream.on('error', () => response.destroy());
        stream.pipe(response);
      }
    } catch (error) {
      if (process.env.WEBVIEW_TEST_DATA) {
        const detail = error instanceof Error ? error.message : 'unknown error';
        console.error('[frontend] resource failed=' + requestPath + ':' + detail.slice(0, 120));
      }
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('Not found');
    }
  });
  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url || '/', baseUrl);
      const match = url.pathname.match(/^\/cdp\/([0-9a-f]{64})$/);
      const local = new URL(baseUrl);
      const endpoint = match && !url.search && !url.hash ? targets.get(match[1]) : null;
      if (!endpoint || request.headers.origin !== local.origin || request.headers.host !== local.host) throw new Error('forbidden');
      webSocketServer.handleUpgrade(request, socket, head, (client) => relayConnection(client, endpoint));
    } catch {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('前端服务启动失败');
  baseUrl = 'http://127.0.0.1:' + address.port + '/';
  return {
    baseUrl,
    entry(value) {
      try {
        const url = new URL(value);
        const match = url.pathname.match(/^\/serve_rev\/@([0-9a-f]{40})\/inspector\.html$/);
        if (url.protocol !== 'https:' || url.hostname !== 'chrome-devtools-frontend.appspot.com' ||
            url.port || url.username || url.password || url.search || url.hash || !match) return null;
        revisions.add(match[1]);
        return baseUrl + match[1] + '/inspector.html';
      } catch {
        return null;
      }
    },
    relay(value) {
      try {
        const endpoint = new URL(value);
        if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' ||
            !/^\/devtools\/page\/[A-Za-z0-9._:-]+$/.test(endpoint.pathname) ||
            !/^\d+$/.test(endpoint.port) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
        const token = randomBytes(32).toString('hex');
        targets.set(token, endpoint.toString());
        return 'ws://127.0.0.1:' + address.port + '/cdp/' + token;
      } catch {
        return null;
      }
    },
    release(value) {
      try {
        const endpoint = new URL(value);
        const local = new URL(baseUrl);
        const match = endpoint.pathname.match(/^\/cdp\/([0-9a-f]{64})$/);
        if (endpoint.protocol !== 'ws:' || endpoint.host !== local.host || endpoint.username || endpoint.password ||
            endpoint.search || endpoint.hash || !match) return false;
        return targets.delete(match[1]);
      } catch {
        return false;
      }
    },
    close: () => {
      targets.clear();
      for (const client of clients) client.terminate();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** @returns {Bounds | null} */
export function inspectorBounds(value, container) {
  if (!value || typeof value !== 'object' || !container ||
      !Number.isFinite(container.width) || !Number.isFinite(container.height)) return null;
  const input = /** @type {Record<string, unknown>} */ (value);
  if (!['x', 'y', 'width', 'height'].every((key) => Number.isFinite(input[key]))) return null;
  const x = Math.max(0, Math.round(Number(input.x)));
  const y = Math.max(0, Math.round(Number(input.y)));
  const width = Math.min(Math.round(Number(input.width)), Math.round(container.width) - x);
  const height = Math.min(Math.round(Number(input.height)), Math.round(container.height) - y);
  return width >= 320 && height >= 240 ? { x, y, width, height } : null;
}
