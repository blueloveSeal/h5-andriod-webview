import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { inspectorBounds, inspectorDiagnostics, inspectorUrl, startInspectorFrontend } from '../electron/services/inspector.mjs';

test('DevTools 只接受自有 localhost 页面端点', () => {
  const entry = 'http://127.0.0.1:52100/be2c1f4fd451578a9ada68a0ac12d659362b44bf/inspector.html';
  const url = inspectorUrl('ws://127.0.0.1:43210/cdp/' + 'a'.repeat(64), entry);
  assert.match(url, /^http:\/\/127\.0\.0\.1:52100\/[0-9a-f]+\/inspector\.html\?/);
  assert.match(url, /ws=127\.0\.0\.1%3A43210/);
  assert.throws(() => inspectorUrl('ws://example.com/devtools/page/page-1', entry));
  assert.throws(() => inspectorUrl('wss://127.0.0.1/devtools/page/page-1', entry));
  assert.throws(() => inspectorUrl('ws://127.0.0.1:43210/devtools/browser/root', entry));
  assert.throws(() => inspectorUrl('ws://127.0.0.1:43210/cdp/' + 'a'.repeat(64) + '?token=x', entry));
  assert.throws(() => inspectorUrl('ws://127.0.0.1:43210/cdp/' + 'a'.repeat(64), 'https://example.com/inspector.html'));
});

test('兼容诊断包含版本信息且不会泄露本机调试端点', () => {
  const diagnostics = inspectorDiagnostics({
    packageName: 'org.example.app', title: '页面\n标题', url: 'https://example.com/path', browser: 'Chrome/143',
    protocolVersion: '1.3', webkitVersion: '537.36', frontendRevision: 'a'.repeat(40),
    endpoint: 'ws://127.0.0.1:43210/devtools/page/private',
  }, '152.0.7977.78');
  assert.match(diagnostics, /APP：org\.example\.app/);
  assert.match(diagnostics, /页面：页面 标题/);
  assert.match(diagnostics, /CDP：1\.3/);
  assert.match(diagnostics, /DevTools 前端修订：a{40}/);
  assert.doesNotMatch(diagnostics, /127\.0\.0\.1|private/);
});

test('前端代理剥离本机查询参数并只请求已登记的官方修订', async () => {
  const upstream = [];
  const frontend = await startInspectorFrontend({
    fetcher: async (url) => {
      upstream.push(url);
      return new Response('<!doctype html><title>DevTools</title>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
  });
  try {
    assert.match(frontend.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const official = 'https://chrome-devtools-frontend.appspot.com/serve_rev/@be2c1f4fd451578a9ada68a0ac12d659362b44bf/inspector.html';
    const entry = frontend.entry(official);
    assert.ok(entry);
    const relay = frontend.relay('ws://127.0.0.1:43210/devtools/page/page-1');
    assert.ok(relay);
    const page = await fetch(inspectorUrl(relay, entry));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /DevTools/);
    assert.deepEqual(upstream, [official]);
    assert.equal((await fetch(frontend.baseUrl + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/inspector.html')).status, 404);
    assert.equal((await fetch(entry, { method: 'POST' })).status, 405);
    assert.equal(frontend.entry('https://example.com/serve_rev/@be2c1f4fd451578a9ada68a0ac12d659362b44bf/inspector.html'), null);
  } finally {
    await frontend.close();
  }
});

test('本地 WebSocket 中继校验来源并双向传递 CDP 消息', async () => {
  const upstreamServer = http.createServer();
  const upstreamSockets = new WebSocketServer({ server: upstreamServer });
  upstreamSockets.on('connection', (socket) => socket.on('message', (data) => socket.send(data)));
  await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
  const address = upstreamServer.address();
  assert.ok(address && typeof address !== 'string');
  const relayStates = [];
  const frontend = await startInspectorFrontend({ onRelayState: (state) => relayStates.push(state) });
  try {
    const relay = frontend.relay('ws://127.0.0.1:' + address.port + '/devtools/page/page-1');
    assert.ok(relay);
    const denied = new WebSocket(relay, { origin: 'http://example.com' });
    const deniedStatus = await new Promise((resolve) => denied.once('unexpected-response', (_request, response) => resolve(response.statusCode)));
    assert.equal(deniedStatus, 403);
    const client = new WebSocket(relay, { origin: new URL(frontend.baseUrl).origin });
    await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
    client.send('{"id":1,"method":"Runtime.enable"}');
    const message = await new Promise((resolve) => client.once('message', (data) => resolve(data.toString())));
    assert.equal(message, '{"id":1,"method":"Runtime.enable"}');
    const upstream = [...upstreamSockets.clients][0];
    upstream.close(1012, 'restart');
    await new Promise((resolve) => client.once('close', resolve));
    assert.equal(relayStates[0].state, 'open');
    assert.equal(relayStates.at(-1).state, 'closed');
    assert.equal(relayStates.at(-1).endpoint, 'ws://127.0.0.1:' + address.port + '/devtools/page/page-1');
  } finally {
    await frontend.close();
    await new Promise((resolve) => upstreamSockets.close(() => upstreamServer.close(resolve)));
  }
});

test('关闭调试视图时释放本地中继登记', async () => {
  const frontend = await startInspectorFrontend();
  try {
    const relay = frontend.relay('ws://127.0.0.1:43210/devtools/page/page-1');
    assert.ok(relay);
    assert.equal(frontend.release(relay), true);
    assert.equal(frontend.release(relay), false);
    const client = new WebSocket(relay, { origin: new URL(frontend.baseUrl).origin });
    const status = await new Promise((resolve) => client.once('unexpected-response', (_request, response) => resolve(response.statusCode)));
    assert.equal(status, 403);
  } finally {
    await frontend.close();
  }
});

test('调试视图边界取整并限制在主窗口内容区', () => {
  assert.deepEqual(
    inspectorBounds({ x: 566.4, y: 118.6, width: 1000, height: 900 }, { width: 1440, height: 900 }),
    { x: 566, y: 119, width: 874, height: 781 },
  );
  assert.deepEqual(
    inspectorBounds({ x: -10, y: -3, width: 600, height: 400 }, { width: 1440, height: 900 }),
    { x: 0, y: 0, width: 600, height: 400 },
  );
  assert.equal(inspectorBounds({ x: 1300, y: 800, width: 500, height: 500 }, { width: 1440, height: 900 }), null);
  assert.equal(inspectorBounds({ x: '0', y: 0, width: 500, height: 500 }, { width: 1440, height: 900 }), null);
});
