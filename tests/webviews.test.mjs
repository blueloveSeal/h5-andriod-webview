import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebViewDiscovery, foregroundPackage, frontendEntry, pageGeometry, socketNames, screenSize, readJson } from '../electron/services/webviews.mjs';

test('调试 socket 去重并拒绝非 WebView 名称', () => {
  assert.deepEqual(socketNames('@webview_devtools_remote_12\n@webview_devtools_remote_12\n@chrome_devtools_remote\n@webview_devtools_remote_BAD'), ['webview_devtools_remote_12']);
});

test('预加载页面即使 visible 为真，也不能作为屏幕内候选', () => {
  const screen = screenSize('Physical size: 1440x3200\nOverride size: 1280x2778');
  assert.deepEqual(screen, { width: 1280, height: 2778 });
  const description = (x) => JSON.stringify({ visible: true, attached: true, width: 1280, height: 2474, screenX: x, screenY: 152 });
  assert.equal(pageGeometry(description(0), screen).candidate, true);
  assert.equal(pageGeometry(description(1280), screen).candidate, false);
  assert.equal(pageGeometry(description(-1280), screen).candidate, false);
  assert.equal(pageGeometry('invalid', screen).candidate, false);
  assert.equal(pageGeometry('null', screen).candidate, false);
  assert.equal(pageGeometry(description(0), null).candidate, false);
});

test('只从 Android 已恢复 Activity 标记提取前台包名', () => {
  assert.equal(foregroundPackage('topResumedActivity=ActivityRecord{abc u0 org.example.app/.MainActivity t42}'), 'org.example.app');
  assert.equal(foregroundPackage('ResumedActivity: ActivityRecord{abc u0 com.example/com.example.Main t3}'), 'com.example');
  assert.equal(foregroundPackage('mFocusedApp=ActivityRecord{abc u0 org.background/.Main}'), '');
});

test('只接受 Chrome 官方且带固定修订号的远程前端', () => {
  const valid = 'https://chrome-devtools-frontend.appspot.com/serve_rev/@be2c1f4fd451578a9ada68a0ac12d659362b44bf/inspector.html?ws=untrusted';
  assert.equal(frontendEntry(valid), valid.split('?')[0]);
  assert.equal(frontendEntry('http://chrome-devtools-frontend.appspot.com/serve_rev/@be2c1f4fd451578a9ada68a0ac12d659362b44bf/inspector.html'), null);
  assert.equal(frontendEntry('https://example.com/serve_rev/@be2c1f4fd451578a9ada68a0ac12d659362b44bf/inspector.html'), null);
  assert.equal(frontendEntry('https://chrome-devtools-frontend.appspot.com/serve_rev/latest/inspector.html'), null);
});

function fixture() {
  const calls = [];
  let sockets = '@webview_devtools_remote_12';
  let fail = false;
  let jsonFail = false;
  let forward = false;
  let foreground = 'org.example.app';
  const discovery = new WebViewDiscovery({
    run: async (file, args) => {
      calls.push(args);
      if (args.includes('/proc/net/unix')) {
        if (fail) throw new Error('offline');
        return sockets;
      }
      if (args.includes('wm')) return 'Physical size: 1280x2778';
      if (args.includes('dumpsys')) return 'topResumedActivity=ActivityRecord{abc u0 ' + foreground + '/.Main t1}';
      if (args.includes('tcp:0')) { forward = true; return '43210'; }
      if (args.includes('--list')) return forward ? 'phone-a tcp:43210 localabstract:webview_devtools_remote_12\nother tcp:9999 localabstract:other' : '';
      if (args.includes('--remove')) { forward = false; return ''; }
      throw new Error('Unexpected command');
    },
    json: async (_port, route) => {
      if (jsonFail) throw new Error('busy');
      return route.endsWith('version') ? { 'Android-Package': 'org.example.app', Browser: 'Chrome/143' } : [
        { id: 'page-1', type: 'page', title: 'Example', url: 'https://example.com', webSocketDebuggerUrl: 'ws://untrusted.example/devtools/page/page-1', devtoolsFrontendUrl: 'https://chrome-devtools-frontend.appspot.com/serve_rev/@be2c1f4fd451578a9ada68a0ac12d659362b44bf/inspector.html?ws=ignored', description: '{"visible":true,"attached":true,"width":1280,"height":2400,"screenX":0,"screenY":100}' },
        { id: 'bad', type: 'page', webSocketDebuggerUrl: 'wss://example.com/anything' },
      ];
    },
  });
  return { discovery, calls, disappear: () => { sockets = ''; }, fail: () => { fail = true; }, failJson: () => { jsonFail = true; }, background: () => { foreground = 'com.android.launcher'; } };
}

test('只使用自建 localhost 转发，保留稳定目标标识并复用端口', async () => {
  const { discovery, calls } = fixture();
  const first = await discovery.scan('phone-a');
  assert.equal(first.pages.length, 1);
  assert.equal(first.pages[0].packageName, 'org.example.app');
  assert.equal(first.pages[0].candidate, true);
  assert.equal(discovery.target(first.pages[0].id).endpoint, 'ws://127.0.0.1:43210/devtools/page/page-1');
  assert.match(discovery.target(first.pages[0].id).frontend, /^https:\/\/chrome-devtools-frontend\.appspot\.com\/serve_rev\/@/);
  const second = await discovery.scan('phone-a');
  assert.equal(second.pages[0].id, first.pages[0].id);
  assert.equal(calls.filter((args) => args.includes('tcp:0')).length, 1);
  await discovery.close();
  assert.deepEqual(calls.at(-1), ['-s', 'phone-a', 'forward', '--remove', 'tcp:43210']);
});

test('后台 APP 即使页面几何信息可见也不能成为自动跟随候选', async () => {
  const { discovery, background } = fixture();
  assert.equal((await discovery.scan('phone-a')).pages[0].candidate, true);
  background();
  assert.equal((await discovery.scan('phone-a')).pages[0].candidate, false);
  await discovery.close();
});

test('页面进程消失后清理目标和所属转发', async () => {
  const { discovery, calls, disappear } = fixture();
  const result = await discovery.scan('phone-a');
  disappear();
  assert.deepEqual(await discovery.scan('phone-a'), { pages: [], error: null });
  assert.equal(discovery.target(result.pages[0].id), undefined);
  assert.equal(calls.filter((args) => args.includes('--remove')).length, 1);
  await discovery.close();
});

test('断开设备返回可处理错误并清理转发', async () => {
  const { discovery, calls, fail } = fixture();
  await discovery.scan('phone-a');
  fail();
  assert.ok((await discovery.scan('phone-a')).error);
  assert.equal(calls.filter((args) => args.includes('--remove')).length, 1);
  await discovery.close();
});

test('调试列表短暂不可读时保留目标和转发', async () => {
  const { discovery, calls, failJson } = fixture();
  const first = await discovery.scan('phone-a');
  failJson();
  const retry = await discovery.scan('phone-a');
  assert.equal(retry.pages[0].id, first.pages[0].id);
  assert.ok(retry.error);
  assert.ok(discovery.target(first.pages[0].id));
  assert.equal(calls.filter((args) => args.includes('--remove')).length, 0);
  await discovery.close();
});

test('并发扫描串行化，切换为空设备后不遗留旧目标', async () => {
  const { discovery, calls } = fixture();
  await Promise.all([discovery.scan('phone-a'), discovery.scan('')]);
  assert.equal(discovery.targets.size, 0);
  assert.equal(calls.filter((args) => args.includes('--remove')).length, 1);
  await discovery.close();
  assert.ok((await discovery.scan('phone-a')).error);
});

test('刷新进行中保留上一轮目标，完成后再原子替换', async () => {
  let release;
  let scans = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const discovery = new WebViewDiscovery({
    run: async (_file, args) => {
      if (args.includes('/proc/net/unix')) {
        scans++;
        if (scans === 2) await gate;
        return '@webview_devtools_remote_12';
      }
      if (args.includes('wm')) return 'Physical size: 1280x2778';
      if (args.includes('dumpsys')) return 'topResumedActivity=ActivityRecord{abc u0 org.example.app/.Main t1}';
      if (args.includes('tcp:0')) return '43210';
      if (args.includes('--list')) return 'phone-a tcp:43210 localabstract:webview_devtools_remote_12';
      if (args.includes('--remove')) return '';
      throw new Error('Unexpected command');
    },
    json: async (_port, route) => route.endsWith('version') ? {} : [
      { id: 'page-1', type: 'page', webSocketDebuggerUrl: 'ws://localhost/devtools/page/page-1', description: '{}' },
    ],
  });
  const first = await discovery.scan('phone-a');
  const refreshing = discovery.scan('phone-a');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(discovery.target(first.pages[0].id));
  release();
  await refreshing;
  await discovery.close();
});

test('JSON 接口拒绝超量响应和重定向', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://example.com' }); res.end(); }
    else { res.end('x'.repeat(1024 * 1024 + 1)); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    await assert.rejects(readJson(port, '/redirect'));
    await assert.rejects(readJson(port, '/large'));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
