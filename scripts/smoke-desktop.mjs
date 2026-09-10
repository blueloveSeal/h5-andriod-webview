import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { executeAdb } from '../electron/services/webviews.mjs';

// 验证实际构建产物；设备数据来自本机 ADB，不使用展示用假数据。
const artifactRoot = path.resolve('output/playwright');
const profile = path.join(artifactRoot, 'smoke-profile');
await mkdir(profile, { recursive: true });
const launchEnv = { ...process.env, WEBVIEW_TEST_DATA: profile };
delete launchEnv.ELECTRON_RUN_AS_NODE;
let desktop;
const verifyWebview = process.argv.includes('--webview');
const adb = process.env.WEBVIEW_ADB_PATH || 'adb';
const forwardsBefore = verifyWebview ? await executeAdb(adb, ['forward', '--list']) : '';
try {
  desktop = await electron.launch({ args: ['.'], env: launchEnv, timeout: 30000 });
  if (verifyWebview) desktop.process().stderr?.on('data', (chunk) => process.stderr.write(chunk));
  const page = await desktop.firstWindow();
  await page.getByRole('heading', { name: '设备', exact: true }).waitFor();
  await page.waitForFunction(() => Boolean(window.workbench));
  const isolation = await page.evaluate(() => ({
    node: typeof window.require,
    bridge: typeof window.workbench.devices,
  }));
  assert.equal(isolation.node, 'undefined');
  assert.equal(isolation.bridge, 'function');
  const snapshot = await page.locator('body').ariaSnapshot();
  assert.ok(snapshot.includes('WebView'));
  const state = await page.evaluate(() => window.workbench.devices());
  assert.ok(Array.isArray(state.devices));
  await page.getByRole('button', { name: '刷新设备', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.refresh-button')?.disabled);
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    hasHeading: Boolean(document.querySelector('.inspector-pane')),
  }));
  assert.equal(layout.overflow, false);
  assert.equal(layout.hasHeading, true);
  const preferences = await desktop.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration };
  });
  assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  if (verifyWebview) {
    const device = state.devices.find((entry) => entry.state === 'device');
    assert.ok(device, '需要已授权的 USB 真机');
    const result = await page.evaluate((serial) => window.workbench.pages(serial), device.serial);
    assert.ok(result.pages.length > 0, '需要 APP 打开已启用调试的 WebView');
    await page.locator('.page-item').first().waitFor();
    assert.equal(await page.locator('.page-item').count(), result.pages.length);
    await page.locator('.page-item').last().click();
    assert.equal(await page.locator('.page-item').last().getAttribute('aria-pressed'), 'true');
    await page.locator('.page-item').first().click();
    await page.locator('.open-inspector').click();
    await page.waitForFunction(() => Boolean(document.querySelector('.inspector-close')) || Boolean(document.querySelector('.inspector-error')?.textContent));
    const inspectorError = await page.locator('.inspector-error').textContent().catch(() => '');
    assert.equal(inspectorError, '', inspectorError || 'DevTools 未进入打开状态');
    await page.waitForTimeout(4000);
    const devtools = await desktop.evaluate(async ({ webContents }) => {
      const all = webContents.getAllWebContents();
      const contents = all.find((entry) => entry.getTitle() === 'DevTools' || /\/[0-9a-f]{40}\/inspector\.html(?:\?|$)/.test(entry.getURL()));
      if (!contents) return { missing: all.map((entry) => {
        const url = new URL(entry.getURL());
        return { title: entry.getTitle(), location: url.origin + url.pathname };
      }) };
      const state = await contents.executeJavaScript('(() => { const contains = (root, text) => root.textContent?.includes(text) || [...root.querySelectorAll("*")].some((node) => node.shadowRoot && contains(node.shadowRoot, text)); return { title: document.title, ready: document.readyState, hasUi: document.body?.id === "-blink-dev-tools" && document.body.childElementCount > 0, hasElementsPanel: Boolean(document.querySelector(".panel.elements")), disconnected: contains(document, "Debugging connection was closed") }; })()');
      return { ...state, url: contents.getURL(), chrome: process.versions.chrome };
    });
    assert.ok(!('missing' in devtools), JSON.stringify(devtools));
    if (process.argv.includes('--screenshot')) {
      const devtoolsImage = await desktop.evaluate(async ({ webContents }) => {
        const contents = webContents.getAllWebContents().find((entry) => entry.getTitle() === 'DevTools' || /\/[0-9a-f]{40}\/inspector\.html(?:\?|$)/.test(entry.getURL()));
        return (await contents.capturePage()).toPNG().toString('base64');
      });
      await writeFile(path.join(artifactRoot, 'devtools.png'), Buffer.from(devtoolsImage, 'base64'));
    }
    assert.equal(devtools.ready, 'complete');
    assert.equal(devtools.hasUi, true);
    assert.equal(devtools.hasElementsPanel, true, JSON.stringify(devtools));
    assert.equal(devtools.disconnected, false, JSON.stringify(devtools));
    assert.match(devtools.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{40}\/inspector\.html\?/);
    console.log('WebView 真机验证通过：页面数量 ' + result.pages.length + '，屏幕内候选 ' + result.pages.filter((entry) => entry.candidate).length + '，内嵌 DevTools 已加载（Electron Chromium ' + devtools.chrome + '）。');
  }
  if (process.argv.includes('--screenshot')) await page.screenshot({ path: path.join(artifactRoot, 'desktop.png') });
  console.log('桌面验证通过：窗口、受限 IPC、设备刷新、布局和进程隔离。设备数量：' + state.devices.length);
} finally {
  await desktop?.close();
  if (verifyWebview) {
    const forwardsAfter = await executeAdb(adb, ['forward', '--list']);
    assert.equal(forwardsAfter.trim(), forwardsBefore.trim(), '退出后应清理本工具的转发');
  }
}
