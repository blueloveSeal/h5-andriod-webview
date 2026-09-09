import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

// 验证实际构建产物；设备数据来自本机 ADB，不使用展示用假数据。
const artifactRoot = path.resolve('output/playwright');
const profile = path.join(artifactRoot, 'smoke-profile');
await mkdir(profile, { recursive: true });
const launchEnv = { ...process.env, WEBVIEW_TEST_DATA: profile };
delete launchEnv.ELECTRON_RUN_AS_NODE;
let desktop;
try {
  desktop = await electron.launch({ args: ['.'], env: launchEnv, timeout: 30000 });
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
  if (process.argv.includes('--screenshot')) await page.screenshot({ path: path.join(artifactRoot, 'desktop.png') });
  console.log('桌面验证通过：窗口、受限 IPC、设备刷新、布局和进程隔离。设备数量：' + state.devices.length);
} finally {
  await desktop?.close();
}
