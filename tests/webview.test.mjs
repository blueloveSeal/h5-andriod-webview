import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { discoverWebViews, isPackageName, parseAppProcessIds, WebViewError } from '../scripts/lib/webview.mjs';
import { main, parseOptions, waitForAbort } from '../scripts/webview.mjs';

const ok = (stdout) => ({ ok: true, stdout });
const version = { protocolVersion: '1.3', product: 'Chrome/139.0.7258.143', userAgent: 'private-fixture' };
const errorCode = (expected) => (error) => error instanceof WebViewError && error.code === expected
  && !error.message.includes('private-fixture');

function fixture() {
  const state = {
    serial: 'fixture-device', nextPort: 43100, calls: [], httpCalls: [], connections: [], closedClients: 0,
    processes: 'PID NAME\n123 com.fixture.app\n124 com.fixture.app:remote\n300 com.fixture.app.lookalike\n500 other.app\n',
    sockets: '@webview_devtools_remote_123\n@webview_devtools_remote_123\n'
      + '@webview_devtools_remote_300\n@webview_devtools_remote_500\n@chrome_devtools_remote\n',
    forwards: new Map([['tcp:48000', { serial: 'unrelated-device', local: 'tcp:48000', remote: 'localabstract:unrelated' }]]),
  };
  const executeAdb = async (file, args) => {
    const command = args[0] === '-s' ? args.slice(2) : args;
    const key = command.join(' ');
    state.calls.push({ file, args: [...args] });
    const overridden = await state.adbOverride?.(key, args);
    if (overridden !== undefined) return overridden;
    if (key === 'devices -l') return ok(`List of devices attached\n${state.serial} device\n`);
    if (key === 'get-devpath') return ok('usb:1-2\n');
    if (key === '-d get-serialno') return { ok: false, code: 'command_failed' };
    if (key === 'shell ps -A -o PID,NAME') return ok(state.processes);
    if (key === 'shell cat /proc/net/unix') return ok(state.sockets);
    if (command[0] === 'forward' && command[1] === '--no-rebind') {
      assert.equal(command[2], 'tcp:0');
      const port = ++state.nextPort;
      state.forwards.set(`tcp:${port}`, { serial: state.serial, local: `tcp:${port}`, remote: command[3] });
      state.onForward?.(port);
      return ok(state.forwardOutput ?? `${port}\n`);
    }
    if (key === 'forward --list') {
      return ok([...state.forwards.values()].map((entry) => `${entry.serial} ${entry.local} ${entry.remote}`).join('\n'));
    }
    if (command[0] === 'forward' && command[1] === '--remove') {
      assert.equal(command.length, 3);
      assert.notEqual(command[2], 'tcp:48000');
      state.forwards.delete(command[2]);
      return ok('');
    }
    assert.fail('Unexpected fixed ADB command in fixture');
  };
  const defaultPages = (port) => {
    const remote = state.forwards.get(`tcp:${port}`)?.remote;
    const pid = remote?.split('_').at(-1) ?? 'missing';
    return [{ id: `fixture-page-${pid}`, type: 'page', title: 'private-fixture-title',
      url: 'https://example.invalid/private-fixture',
      webSocketDebuggerUrl: `ws://localhost:${port}/devtools/page/fixture-page-${pid}`,
      devtoolsFrontendUrl: 'https://example.invalid/private-fixture',
      description: JSON.stringify({ visible: true, attached: true, width: 1080, height: 2400, extra: 'private-fixture' }) }];
  };
  const readJson = async (port, path, options) => {
    state.httpCalls.push({ port, path, options });
    assert.equal(path, '/json/list');
    return state.pages ? state.pages(port, defaultPages(port)) : defaultPages(port);
  };
  const connect = async (url, options) => {
    state.connections.push({ url, options });
    return {
      async request(method, params) {
        assert.equal(method, 'Browser.getVersion');
        assert.deepEqual(params, {});
        return state.getVersion ? state.getVersion() : version;
      },
      async close() { state.closedClients += 1; },
    };
  };
  return { state, options: { adb: 'C:/Platform Tools/adb.exe', packageName: 'com.fixture.app', executeAdb, readJson, connect } };
}

async function openFixture(t, setup) {
  const fake = fixture();
  setup?.(fake.state);
  const session = await discoverWebViews(fake.options);
  t.after(() => session.close());
  return { ...fake, session };
}

const removals = (state) => state.calls.filter(({ args }) => args.includes('--remove'));

test('包名和进程解析严格匹配主进程及冒号子进程', () => {
  assert.equal(isPackageName('com.fixture.app'), true);
  for (const name of ['', 'app', 'com.fixture.app;id', 'com.fixture.app/other', 'com..app']) assert.equal(isPackageName(name), false);
  const fake = fixture();
  assert.deepEqual([...parseAppProcessIds(fake.state.processes, 'com.fixture.app')], ['123', '124']);
  assert.equal(parseAppProcessIds('unknown private-fixture', 'com.fixture.app'), null);
  assert.equal(parseAppProcessIds('PID NAME\n123 com.fixture.app\n123 other.app', 'com.fixture.app'), null);
  assert.equal(parseAppProcessIds('PID NAME\n0 com.fixture.app', 'com.fixture.app'), null);
  assert.equal(parseAppProcessIds('PID NAME\n2147483648 com.fixture.app', 'com.fixture.app'), null);
  assert.deepEqual([...parseAppProcessIds('PID NAME\n', 'com.fixture.app')], []);
});

test('无效参数和提前取消不执行 ADB', async () => {
  const fake = fixture();
  for (const overrides of [{ packageName: 'com.fixture.app;id' }, { serial: '-d' },
    { serial: 'two devices' }, { adb: 'adb\u0000' }, { executeAdb: null }]) {
    await assert.rejects(discoverWebViews({ ...fake.options, ...overrides }), errorCode('invalid_arguments'));
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discoverWebViews({ ...fake.options, signal: controller.signal }), errorCode('aborted'));
  assert.equal(fake.state.calls.length, 0);
});

test('只发现指定 APP 的 socket，输出稳定 ID 和安全页面摘要', async (t) => {
  const { state, session } = await openFixture(t);
  assert.equal(session.targets.length, 1);
  assert.match(session.targets[0].id, /^[a-f0-9]{32}$/);
  assert.deepEqual({ ...session.targets[0], id: 'omitted' }, { id: 'omitted', type: 'page',
    inspectable: true, visible: true, attachedToWindow: true, width: 1080, height: 2400 });
  assert.equal(session.complete, true);
  const output = JSON.stringify(session);
  for (const marker of ['fixture-device', 'private-fixture', 'webview_devtools_remote', 'fixture-page-123']) {
    assert.equal(output.includes(marker), false);
  }
  const created = state.calls.filter(({ args }) => args.includes('--no-rebind'));
  assert.equal(created.length, 1);
  assert.equal(created[0].args.at(-1), 'localabstract:webview_devtools_remote_123');
  assert.ok(state.calls.every(({ file }) => file === 'C:/Platform Tools/adb.exe'));
  assert.ok(state.calls.filter(({ args }) => args[0] === '-s').every(({ args }) => args[1] === state.serial));
});

test('相同页面跨临时端口保留 ID，不同设备使用不同 ID', async (t) => {
  const first = await openFixture(t);
  const second = await openFixture(t, (state) => { state.nextPort = 44100; });
  const other = await openFixture(t, (state) => { state.serial = 'another-fixture-device'; });
  assert.equal(first.session.targets[0].id, second.session.targets[0].id);
  assert.notEqual(first.session.targets[0].id, other.session.targets[0].id);
});

test('多设备或未授权设备不会创建转发', async () => {
  for (const [devices, expected] of [
    ['List of devices attached\none device\ntwo device\n', 'device_selection_required'],
    ['List of devices attached\none unauthorized\n', 'device_unauthorized'],
  ]) {
    const fake = fixture();
    fake.state.adbOverride = (key) => key === 'devices -l' ? ok(devices) : undefined;
    await assert.rejects(discoverWebViews(fake.options), errorCode(expected));
    assert.equal(fake.state.calls.length, 1);
  }
});

test('缺失进程、不可识别 ps、无归属 socket 和无调试 socket 均不创建转发', async () => {
  for (const [processes, sockets, expected] of [
    ['PID NAME\n500 other.app\n', '@webview_devtools_remote_500', 'app_not_running'],
    ['private-fixture', '@webview_devtools_remote_123', 'processes_unavailable'],
    ['PID NAME\n123 com.fixture.app\n', '@webview_devtools_remote', 'socket_owner_unverified'],
    ['PID NAME\n123 com.fixture.app\n', '@webview_devtools_remote_500', 'no_webview_socket'],
  ]) {
    const fake = fixture();
    fake.state.processes = processes;
    fake.state.sockets = sockets;
    await assert.rejects(discoverWebViews(fake.options), errorCode(expected));
    assert.equal(fake.state.forwards.size, 1);
  }
});

test('完整多进程发现要求显式页面 ID，已消失的 ID 不回退', async (t) => {
  const { session, state } = await openFixture(t, (value) => { value.sockets += '@webview_devtools_remote_124\n'; });
  assert.equal(session.targets.length, 2);
  await assert.rejects(session.verify(), errorCode('target_selection_required'));
  await assert.rejects(session.verify('f'.repeat(32)), errorCode('target_missing'));
  assert.equal(state.connections.length, 0);
  const selected = session.targets[0].id;
  const result = await session.verify(selected);
  assert.equal(result.target, selected);
  assert.equal(result.protocolVersion, '1.3');
  assert.equal(result.browserVersion, '139.0.7258.143');
  assert.match(result.devtoolsFrontendUrl, /^devtools:\/\/devtools\/bundled\/inspector\.html\?ws=127\.0\.0\.1:/);
  assert.equal(JSON.stringify(result).includes('private-fixture'), false);
  assert.equal(state.closedClients, 1);
});

test('部分 socket 失败时保留安全诊断，不自动选择剩余页面', async (t) => {
  const { session, state } = await openFixture(t, (value) => {
    value.sockets += '@webview_devtools_remote_124\n';
    value.pages = (port, defaults) => {
      if (port === 43102) throw new Error('private-fixture');
      return defaults;
    };
  });
  assert.equal(session.complete, false);
  assert.equal(session.targets.length, 1);
  assert.equal(session.warnings[0].code, 'endpoint_unavailable');
  assert.equal(JSON.stringify(session.warnings).includes('private-fixture'), false);
  await assert.rejects(session.verify(), errorCode('target_selection_required'));
  await session.verify(session.targets[0].id);
  assert.equal(state.connections.length, 1);
  assert.equal((await session.close()).removed, 2);
});

test('拒绝不属于本机转发的调试地址，并忽略远端前端 URL', async (t) => {
  const { session, state } = await openFixture(t, (value) => {
    value.pages = (_port, defaults) => defaults.map((page) => ({ ...page,
      webSocketDebuggerUrl: 'ws://example.invalid:1234/devtools/page/fixture-page-123' }));
  });
  assert.equal(session.targets[0].inspectable, false);
  assert.equal(session.warnings[0].code, 'endpoint_rejected');
  await assert.rejects(session.verify(session.targets[0].id), errorCode('target_not_inspectable'));
  assert.equal(state.connections.length, 0);
});

test('畸形页面列表、重复页面 ID 不被当作可连接页面', async (t) => {
  for (const payload of [{ targets: [] }, [{ type: 'page', id: '../private-fixture' }],
    [{ type: 'page', id: 'same' }, { type: 'page', id: 'same' }]]) {
    const { session } = await openFixture(t, (state) => { state.pages = () => payload; });
    assert.equal(session.targets.length, 0);
    assert.equal(session.warnings[0].code, 'invalid_targets');
  }
});

test('只支持 page 类型，缺少调试地址时明确不可连接', async (t) => {
  const { session } = await openFixture(t, (state) => {
    state.pages = () => [{ type: 'service_worker', id: 'worker' }, { type: 'page', id: 'page',
      description: '{"visible":false,"width":-1,"height":"private-fixture"}' }];
  });
  assert.equal(session.targets.length, 1);
  assert.equal(session.targets[0].inspectable, false);
  assert.equal(session.targets[0].visible, false);
  assert.equal(session.targets[0].width, null);
  assert.equal(session.targets[0].height, null);
  await assert.rejects(session.verify(), errorCode('no_inspectable_pages'));
});

test('校验连接前重新核对 APP 进程、转发和页面是否还存在', async (t) => {
  const processChanged = await openFixture(t);
  processChanged.state.processes = 'PID NAME\n123 other.app\n';
  await assert.rejects(processChanged.session.verify(), errorCode('target_changed'));
  assert.equal(processChanged.state.connections.length, 0);
  const forwardChanged = await openFixture(t);
  forwardChanged.state.forwards.get('tcp:43101').remote = 'localabstract:unrelated';
  await assert.rejects(forwardChanged.session.verify(), errorCode('forward_changed'));
  assert.equal(forwardChanged.state.connections.length, 0);
  const pageChanged = await openFixture(t);
  pageChanged.state.pages = () => [];
  await assert.rejects(pageChanged.session.verify(), errorCode('target_missing'));
  assert.equal(pageChanged.state.connections.length, 0);
});

test('CDP 校验失败仍关闭探测连接，且不传播原始异常', async (t) => {
  const failed = await openFixture(t);
  failed.state.getVersion = () => { throw new Error('private-fixture'); };
  await assert.rejects(failed.session.verify(), errorCode('webview_failed'));
  assert.equal(failed.state.closedClients, 1);
  const invalid = await openFixture(t);
  invalid.state.getVersion = () => ({ protocolVersion: 'private-fixture', product: 'unknown' });
  await assert.rejects(invalid.session.verify(), errorCode('invalid_cdp_version'));
  assert.equal(invalid.state.closedClients, 1);
});

test('close 幂等，只删除本会话仍拥有的转发', async (t) => {
  const { session, state } = await openFixture(t);
  const closing = session.close();
  assert.strictEqual(session.close(), closing);
  assert.deepEqual(await closing, { ok: true, code: 'cleanup_complete', removed: 1, preserved: 0, uncertainForward: false });
  assert.equal(removals(state).length, 1);
  assert.equal(state.forwards.size, 1);
  assert.ok(state.forwards.has('tcp:48000'));
  assert.equal(state.calls.some(({ args }) => args.includes('--remove-all') || args.includes('kill-server')), false);
  await assert.rejects(session.verify(), errorCode('session_closed'));
});

test('已被其他工具替换或移除的转发不会被误删', async (t) => {
  const replaced = await openFixture(t);
  replaced.state.forwards.get('tcp:43101').remote = 'localabstract:another-owner';
  const result = await replaced.session.close();
  assert.equal(result.preserved, 1);
  assert.equal(removals(replaced.state).length, 0);
  const absent = await openFixture(t);
  absent.state.forwards.delete('tcp:43101');
  assert.equal((await absent.session.close()).ok, true);
  assert.equal(removals(absent.state).length, 0);
});

test('清理时无法核实所有权或移除失败，报告失败而非伪报成功', async (t) => {
  for (const failingCommand of ['forward --list', 'forward --remove tcp:43101']) {
    const { session, state } = await openFixture(t);
    state.adbOverride = (key) => key === failingCommand ? { ok: false, code: 'timeout' } : undefined;
    const result = await session.close();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'cleanup_incomplete');
    assert.ok(state.forwards.has('tcp:43101'));
  }
});

test('创建转发返回未知端口时不会猜测删除范围', async () => {
  const fake = fixture();
  fake.state.forwardOutput = 'private-fixture';
  await assert.rejects(discoverWebViews(fake.options), (error) => {
    assert.equal(error.code, 'forward_unverified');
    assert.equal(error.cleanup.ok, false);
    assert.equal(error.cleanup.uncertainForward, true);
    assert.equal(JSON.stringify(error).includes('private-fixture'), false);
    return true;
  });
  assert.equal(removals(fake.state).length, 0);
});

test('取消恰好发生在转发创建后，仍清理新端口', async () => {
  const fake = fixture();
  const controller = new AbortController();
  fake.state.onForward = () => controller.abort();
  await assert.rejects(discoverWebViews({ ...fake.options, signal: controller.signal }), (error) => {
    assert.equal(error.code, 'aborted');
    assert.equal(error.cleanup.ok, true);
    assert.equal(error.cleanup.removed, 1);
    return true;
  });
  assert.equal(fake.state.forwards.size, 1);
});

test('close 等待正在执行的 CDP 探测结束后才删除转发', async (t) => {
  const { session, state } = await openFixture(t);
  let release;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  state.getVersion = () => { started(); return new Promise((resolve) => { release = resolve; }); };
  const pending = assert.rejects(session.verify(), errorCode('session_closed'));
  await entered;
  await assert.rejects(session.verify(), errorCode('session_busy'));
  const closing = session.close();
  assert.equal(removals(state).length, 0);
  release(version);
  await pending;
  assert.equal((await closing).removed, 1);
  assert.equal(state.closedClients, 1);
});

function cliFixture(overrides = {}) {
  const state = { output: [], errors: [], closed: 0, selected: undefined };
  const session = { targets: [{ id: 'a'.repeat(32), type: 'page', inspectable: true }],
    complete: true, warnings: [],
    async verify(target) { state.selected = target; return { protocolVersion: '1.3', browserVersion: '139.0.0.0' }; },
    async close() { state.closed += 1; return { ok: true, code: 'cleanup_complete' }; },
    ...overrides };
  return { session, state, options: { discover: async () => session, nodeVersion: '22.18.0',
    stdout: (text) => state.output.push(text), stderr: (text) => state.errors.push(text) } };
}

test('CLI 参数支持路径、包名和稳定 ID，拒绝重复及不完整选项', () => {
  assert.deepEqual(parseOptions(['--package', 'com.fixture.app', '--adb', 'C:/Platform Tools/adb.exe',
    '--serial', 'fixture-device', '--connect', '--target', 'a'.repeat(32)]), {
    packageName: 'com.fixture.app', adb: 'C:/Platform Tools/adb.exe', serial: 'fixture-device', connect: true, target: 'a'.repeat(32),
  });
  for (const args of [[], ['--unknown'], ['--package'], ['--package', 'com.fixture.app;id'],
    ['--package', 'com.fixture.app', '--connect', '--connect'],
    ['--package', 'com.fixture.app', '--target', 'a'.repeat(32)],
    ['--package', 'com.fixture.app', '--connect', '--target', '1'],
    ['--package', 'com.fixture.app', '--serial', '--help']]) assert.throws(() => parseOptions(args), errorCode('invalid_arguments'));
});

test('CLI 帮助、无效参数及旧 Node 不访问设备', async () => {
  const fake = cliFixture();
  fake.options.discover = async () => { assert.fail('Device must not be accessed'); };
  assert.equal(await main(['--help'], fake.options), 0);
  assert.equal(await main([], fake.options), 2);
  assert.equal(await main(['--package', 'com.fixture.app'], { ...fake.options, nodeVersion: '22.11.0' }), 2);
  assert.equal(await main(['--package', 'com.fixture.app', '--connect'], fake.options), 2);
});

test('CLI 发现模式在输出前清理，结果为安全 JSON', async () => {
  const fake = cliFixture();
  fake.options.stdout = (text) => {
    assert.equal(fake.state.closed, 1);
    fake.state.output.push(text);
  };
  assert.equal(await main(['--package', 'com.fixture.app'], fake.options), 0);
  const report = JSON.parse(fake.state.output[0]);
  assert.equal(report.event, 'discovered');
  assert.equal(report.ready, true);
  assert.equal(report.cleanup.ok, true);
});

test('CLI 连接模式传递选择 ID，并在取消后清理', async () => {
  const fake = cliFixture();
  const controller = new AbortController();
  let supplied;
  const result = await main(['--package', 'com.fixture.app', '--connect', '--target', 'a'.repeat(32)], {
    ...fake.options, signal: controller.signal,
    discover: async (options) => { supplied = options; return fake.session; },
    waitForStop: async () => { assert.equal(fake.state.closed, 0); controller.abort(); },
  });
  assert.equal(result, 0);
  assert.equal(Object.hasOwn(supplied, 'connect'), false);
  assert.equal(fake.state.selected, 'a'.repeat(32));
  assert.equal(fake.state.closed, 1);
  assert.deepEqual(fake.state.output.map((line) => JSON.parse(line).event), ['connected', 'closed']);
});

test('CLI 异常不泄露原始消息，连接失败仍关闭会话', async () => {
  const fake = cliFixture({ async verify() { throw new Error('private-fixture'); } });
  const controller = new AbortController();
  assert.equal(await main(['--package', 'com.fixture.app', '--connect'], { ...fake.options, signal: controller.signal }), 1);
  assert.equal(fake.state.closed, 1);
  assert.equal(fake.state.errors.join('\n').includes('private-fixture'), false);
  assert.equal(JSON.parse(fake.state.errors[0]).error.code, 'webview_failed');
});

test('CLI 无页面或清理失败返回非零退出码', async () => {
  const empty = cliFixture({ targets: [] });
  assert.equal(await main(['--package', 'com.fixture.app'], empty.options), 1);
  const failed = cliFixture({ async close() { throw new Error('private-fixture'); } });
  assert.equal(await main(['--package', 'com.fixture.app'], failed.options), 1);
  assert.equal(JSON.parse(failed.state.output[0]).cleanup.ok, false);
  assert.equal(failed.state.output.join('\n').includes('private-fixture'), false);
});

test('CLI 发现途中取消保留清理结果，不把取消报告成未知错误', async () => {
  const fake = cliFixture();
  const controller = new AbortController();
  const result = await main(['--package', 'com.fixture.app'], { ...fake.options, signal: controller.signal,
    discover: async () => {
      controller.abort();
      const error = new WebViewError('aborted');
      error.cleanup = { ok: true, code: 'cleanup_complete' };
      throw error;
    } });
  assert.equal(result, 0);
  assert.equal(fake.state.errors.length, 0);
  assert.equal(JSON.parse(fake.state.output[0]).cleanup.ok, true);
});

test('等待取消的存活句柄在取消后释放', async () => {
  const controller = new AbortController();
  const waiting = waitForAbort(controller.signal);
  controller.abort();
  await waiting;
  await waitForAbort(controller.signal);
  await assert.rejects(waitForAbort(undefined), errorCode('invalid_arguments'));
});

test('CLI 真实子进程帮助成功，缺少参数返回退出码 2', async () => {
  const execute = promisify(execFile);
  const cli = fileURLToPath(new URL('../scripts/webview.mjs', import.meta.url));
  const { stdout } = await execute(process.execPath, [cli, '--help']);
  assert.match(stdout, /--connect/);
  assert.match(stdout, /Ctrl\+C/);
  await assert.rejects(execute(process.execPath, [cli]), (error) => error.code === 2);
});
