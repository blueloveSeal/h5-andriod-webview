import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { connectCdp, DevToolsError, readDevToolsJson } from '../scripts/lib/devtools.mjs';

const address = 'ws://127.0.0.1:43123/devtools/page/fixture-page';
const code = (expected) => (error) => error instanceof DevToolsError && error.code === expected
  && !error.message.includes('private-fixture');

async function httpFixture(t, handler) {
  const server = createServer(handler);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    // closeAllConnections 不覆盖已升级的 WebSocket；fixture 显式销毁自己接收的连接。
    for (const socket of sockets) socket.destroy();
  }));
  return { server, port: server.address().port };
}

class FakeSocket extends EventTarget {
  readyState = 0;
  sent = [];
  closeCount = 0;
  listeners = new Map();
  failSend = false;
  addEventListener(name, handler, options) {
    const items = this.listeners.get(name) ?? new Set();
    items.add(handler);
    this.listeners.set(name, items);
    super.addEventListener(name, handler, options);
  }
  removeEventListener(name, handler, options) {
    this.listeners.get(name)?.delete(handler);
    super.removeEventListener(name, handler, options);
  }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  raw(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
  message(value) { this.raw(JSON.stringify(value)); }
  send(payload) {
    if (this.failSend) throw new Error('private-fixture');
    this.sent.push(JSON.parse(payload));
  }
  close() {
    this.closeCount += 1;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  listenerCount() { return [...this.listeners.values()].reduce((sum, items) => sum + items.size, 0); }
}

async function cdpFixture(t, options = {}) {
  const socket = new FakeSocket();
  const client = await connectCdp(address, { ...options, webSocketFactory: () => {
    queueMicrotask(() => socket.open());
    return socket;
  } });
  t.after(() => client.close());
  return { client, socket };
}

test('HTTP 只访问固定本机接口并解析 JSON', async (t) => {
  const paths = [];
  const { port } = await httpFixture(t, (request, response) => {
    paths.push(request.url);
    response.end(JSON.stringify({ value: true }));
  });
  assert.deepEqual(await readDevToolsJson(port, '/json/list'), { value: true });
  assert.deepEqual(await readDevToolsJson(port, '/json/version'), { value: true });
  assert.deepEqual(paths, ['/json/list', '/json/version']);
});

test('HTTP 参数在网络访问前验证', async () => {
  for (const [port, path, options] of [
    [0, '/json/list', {}], [65536, '/json/list', {}], ['43123', '/json/list', {}],
    [43123, '//example.invalid/', {}], [43123, '/json/list?private-fixture', {}],
    [43123, '/json/list', { timeoutMs: 0 }], [43123, '/json/list', { maxBytes: Infinity }],
  ]) await assert.rejects(readDevToolsJson(port, path, options), code('invalid_arguments'));
});

test('HTTP 不跟随重定向，也不泄露响应正文', async (t) => {
  let calls = 0;
  const { port } = await httpFixture(t, (_request, response) => {
    calls += 1;
    response.writeHead(302, { Location: '/json/version' });
    response.end('private-fixture');
  });
  await assert.rejects(readDevToolsJson(port, '/json/list'), code('http_failed'));
  assert.equal(calls, 1);
});

test('HTTP 畸形 JSON 和中断连接均返回受控错误', async (t) => {
  const invalid = await httpFixture(t, (_request, response) => response.end('private-fixture'));
  await assert.rejects(readDevToolsJson(invalid.port, '/json/list'), code('invalid_json'));
  const interrupted = await httpFixture(t, (request) => request.socket.destroy());
  await assert.rejects(readDevToolsJson(interrupted.port, '/json/list'), code('http_failed'));
});

test('HTTP 限制分块响应的总字节数', async (t) => {
  const { port } = await httpFixture(t, (_request, response) => {
    response.write('["');
    response.write('x'.repeat(32));
    response.end('"]');
  });
  await assert.rejects(readDevToolsJson(port, '/json/list', { maxBytes: 8 }), code('response_too_large'));
});

test('持续少量数据不能绕过 HTTP 总时限', { timeout: 2000 }, async (t) => {
  const { port } = await httpFixture(t, (_request, response) => {
    response.write('[');
    const timer = setInterval(() => response.write(' '), 5);
    response.once('close', () => clearInterval(timer));
  });
  await assert.rejects(readDevToolsJson(port, '/json/list', { timeoutMs: 40 }), code('http_timeout'));
});

test('HTTP 支持预先取消和请求过程中取消', async (t) => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(readDevToolsJson(43123, '/json/list', { signal: before.signal }), code('aborted'));
  const during = new AbortController();
  const { port } = await httpFixture(t, () => during.abort());
  await assert.rejects(readDevToolsJson(port, '/json/list', { signal: during.signal }), code('aborted'));
});

test('CDP 拒绝外部、带认证、带查询参数或规范化后的地址', async () => {
  let calls = 0;
  for (const url of [
    'ws://example.invalid:43123/devtools/page/fixture-page',
    address.replace('127.0.0.1', 'localhost'), address.replace('127.0.0.1', '127.1'),
    address.replace('127.0.0.1', 'fixture@127.0.0.1'), `${address}?private-fixture`, `${address}#fragment`,
    address.replace('/page/', '/browser/'), address.replace('/page/', '/extra/../page/'),
    address.replace('43123', '65536'), address.replace('43123', '043123'),
    address.replace('fixture-page', '%66ixture-page'),
  ]) {
    await assert.rejects(connectCdp(url, { webSocketFactory: () => { calls += 1; } }), code('invalid_arguments'));
  }
  assert.equal(calls, 0);
});

test('CDP 并发请求按 ID 对应响应，忽略通知', async (t) => {
  const { client, socket } = await cdpFixture(t);
  const first = client.request('Browser.getVersion');
  const second = client.request('Runtime.enable');
  socket.message({ method: 'Runtime.consoleAPICalled', params: { value: 'private-fixture' } });
  socket.message({ id: socket.sent[1].id, result: { second: true } });
  socket.message({ id: socket.sent[0].id, result: { first: true } });
  assert.deepEqual(await Promise.all([first, second]), [{ first: true }, { second: true }]);
});

test('CDP 不输出远端错误中的消息和数据', async (t) => {
  const { client, socket } = await cdpFixture(t);
  const pending = assert.rejects(client.request('Browser.getVersion'), code('cdp_command_failed'));
  socket.message({ id: socket.sent[0].id, error: { code: -1, message: 'private-fixture', data: 'private-fixture' } });
  await pending;
});

test('CDP 超时后不复用 ID，迟到响应不会命中新请求', async (t) => {
  const { client, socket } = await cdpFixture(t);
  await assert.rejects(client.request('Browser.getVersion', {}, { timeoutMs: 10 }), code('cdp_timeout'));
  const next = client.request('Browser.getVersion');
  socket.message({ id: 1, result: { stale: true } });
  socket.message({ id: 2, result: { current: true } });
  assert.deepEqual(await next, { current: true });
  assert.deepEqual(socket.sent.map((item) => item.id), [1, 2]);
});

test('取消单个 CDP 请求不会关闭其他请求', async (t) => {
  const { client, socket } = await cdpFixture(t);
  const controller = new AbortController();
  const canceled = assert.rejects(client.request('Browser.getVersion', {}, { signal: controller.signal }), code('aborted'));
  const other = client.request('Runtime.enable');
  controller.abort();
  socket.message({ id: socket.sent[1].id, result: {} });
  await canceled;
  assert.deepEqual(await other, {});
});

test('预先取消请求不会发送 CDP 命令', async (t) => {
  const { client, socket } = await cdpFixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.request('Browser.getVersion', {}, { signal: controller.signal }), code('aborted'));
  assert.equal(socket.sent.length, 0);
});

test('CDP 限制并发数量，关闭后拒绝所有未完成请求并清理监听器', async (t) => {
  const { client, socket } = await cdpFixture(t);
  const pending = Promise.allSettled(Array.from({ length: 64 }, () => client.request('Browser.getVersion')));
  await assert.rejects(client.request('Browser.getVersion'), code('cdp_pending_limit'));
  await client.close();
  await client.close();
  assert.ok((await pending).every((item) => item.status === 'rejected' && item.reason.code === 'cdp_closed'));
  assert.equal(socket.closeCount, 1);
  assert.equal(socket.listenerCount(), 0);
  await assert.rejects(client.request('Browser.getVersion'), code('cdp_closed'));
});

for (const data of ['not-json', '[]', '{"id":0,"result":{}}', '{"id":1,"result":[]}',
  '{"id":1,"result":{},"error":{}}', new Uint8Array([1, 2])]) {
  test(`CDP 拒绝畸形消息 ${typeof data === 'string' ? data : 'binary'}`, async (t) => {
    const { client, socket } = await cdpFixture(t);
    const pending = assert.rejects(client.request('Browser.getVersion'), code('cdp_invalid_message'));
    socket.raw(data);
    await pending;
    assert.equal(socket.listenerCount(), 0);
  });
}

test('CDP 按字节限制消息大小', async (t) => {
  const { client, socket } = await cdpFixture(t, { maxMessageBytes: 128 });
  const pending = assert.rejects(client.request('Browser.getVersion'), code('cdp_invalid_message'));
  socket.raw('界'.repeat(64));
  await pending;
});

test('CDP 校验命令和参数，序列化错误不会泄露原始异常', async (t) => {
  const { client, socket } = await cdpFixture(t);
  const cyclic = {};
  cyclic.self = cyclic;
  for (const [method, params] of [['private-fixture', {}], ['Browser.getVersion', null],
    ['Browser.getVersion', []], ['Browser.getVersion', cyclic], ['Browser.getVersion', { value: 1n }]]) {
    await assert.rejects(client.request(method, params), code('invalid_arguments'));
  }
  assert.equal(socket.sent.length, 0);
});

test('CDP 构造、发送、连接早退及握手超时均安全失败', async (t) => {
  await assert.rejects(connectCdp(address, { webSocketFactory: () => { throw new Error('private-fixture'); } }),
    code('cdp_connect_failed'));
  const closing = new FakeSocket();
  await assert.rejects(connectCdp(address, { webSocketFactory: () => {
    queueMicrotask(() => closing.close());
    return closing;
  } }), code('cdp_connect_failed'));
  const idle = new FakeSocket();
  await assert.rejects(connectCdp(address, { timeoutMs: 10, webSocketFactory: () => idle }), code('cdp_timeout'));
  assert.equal(idle.listenerCount(), 0);
  const { client, socket } = await cdpFixture(t);
  socket.failSend = true;
  await assert.rejects(client.request('Browser.getVersion'), code('cdp_closed'));
});

test('取消连接在握手前后都释放监听器和请求', async (t) => {
  const before = new AbortController();
  before.abort();
  let invoked = false;
  await assert.rejects(connectCdp(address, { signal: before.signal, webSocketFactory: () => { invoked = true; } }), code('aborted'));
  assert.equal(invoked, false);
  const handshaking = new AbortController();
  const idle = new FakeSocket();
  const opening = assert.rejects(connectCdp(address, { signal: handshaking.signal, webSocketFactory: () => idle }), code('aborted'));
  handshaking.abort();
  await opening;
  assert.equal(idle.listenerCount(), 0);
  const after = new AbortController();
  const { client, socket } = await cdpFixture(t, { signal: after.signal });
  const pending = assert.rejects(client.request('Browser.getVersion'), code('aborted'));
  after.abort();
  await pending;
  assert.equal(socket.listenerCount(), 0);
});

test('原生 WebSocket 可与本机 fixture 完成握手及 CDP 请求',
  { skip: typeof globalThis.WebSocket !== 'function', timeout: 3000 }, async (t) => {
    const peers = new Set();
    const { server, port } = await httpFixture(t, (_request, response) => response.end('{}'));
    t.after(() => { for (const peer of peers) peer.destroy(); });
    server.on('upgrade', (request, socket) => {
      peers.add(socket);
      socket.once('close', () => peers.delete(socket));
      socket.on('error', () => {});
      const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      let answered = false;
      socket.on('data', (data) => {
        if ((data[0] & 0x0f) === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (answered) return;
        answered = true;
        const payload = Buffer.from(JSON.stringify({ id: 1, result: { protocolVersion: '1.3', product: 'Chrome/139.0.0.0' } }));
        socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
      });
    });
    const client = await connectCdp(`ws://127.0.0.1:${port}/devtools/page/fixture-page`);
    t.after(() => client.close());
    assert.deepEqual(await client.request('Browser.getVersion'), { protocolVersion: '1.3', product: 'Chrome/139.0.0.0' });
    await client.close();
  });
