import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { executeAdb } from '../electron/services/webviews.mjs';

async function showDevToolsPanel(desktop, command, panel) {
  return desktop.evaluate(async ({ webContents }, request) => {
    const contents = webContents.getAllWebContents().find((entry) => entry.getTitle() === 'DevTools' || /\/[0-9a-f]{40}\/inspector\.html(?:\?|$)/.test(entry.getURL()));
    if (!contents) return false;
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'P', modifiers: ['control', 'shift'] });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'P', modifiers: ['control', 'shift'] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    contents.insertText(request.command);
    await new Promise((resolve) => setTimeout(resolve, 300));
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    const expression = '(panel => Boolean(UI.panels[panel]) && [...document.querySelectorAll(".panel")].some((node) => node.classList.contains(panel) && node.offsetParent !== null))(' + JSON.stringify(request.panel) + ')';
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await contents.executeJavaScript(expression).catch(() => false)) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }, { command, panel });
}

async function currentDevTools(desktop) {
  return desktop.evaluate(({ webContents }) => {
    const matches = webContents.getAllWebContents().filter((entry) => entry.getTitle() === 'DevTools' || /\/[0-9a-f]{40}\/inspector\.html(?:\?|$)/.test(entry.getURL()));
    return { count: matches.length, id: matches[0]?.id || 0 };
  });
}

async function switchWorkbenchPage(page, desktop, index) {
  const previous = await currentDevTools(desktop);
  await page.locator('.page-item').nth(index).click();
  await page.waitForFunction((target) => document.querySelectorAll('.page-item')[target]?.getAttribute('aria-pressed') === 'true', index);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const current = await currentDevTools(desktop);
    if (current.count === 1 && current.id !== previous.id) return current.id;
    await page.waitForTimeout(250);
  }
  return 0;
}

// 验证实际构建产物；设备数据来自本机 ADB，不使用展示用假数据。
const artifactRoot = path.resolve('output/playwright');
const profile = path.join(artifactRoot, 'smoke-profile');
await mkdir(profile, { recursive: true });
const launchEnv = { ...process.env, WEBVIEW_TEST_DATA: profile };
delete launchEnv.ELECTRON_RUN_AS_NODE;
let desktop;
const verifyWebview = process.argv.includes('--webview');
const executableArgument = process.argv.find((argument) => argument.startsWith('--executable='));
const executablePath = executableArgument ? path.resolve(executableArgument.slice('--executable='.length)) : undefined;
if (executableArgument && !executableArgument.slice('--executable='.length)) throw new Error('--executable 需要有效路径');
const adb = process.env.WEBVIEW_ADB_PATH || 'adb';
const forwardsBefore = verifyWebview ? await executeAdb(adb, ['forward', '--list']) : '';
try {
  desktop = await electron.launch(executablePath ? { executablePath, env: launchEnv, timeout: 30000 } : { args: ['.'], env: launchEnv, timeout: 30000 });
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
    await page.waitForFunction(() => Number(document.querySelector('.phone-video')?.getAttribute('data-frames')) > 0, undefined, { timeout: 30000 });
    const mirror = await page.locator('.phone-video').evaluate((canvas) => ({
      frames: Number(canvas.getAttribute('data-frames')),
      width: canvas.width,
      height: canvas.height,
    }));
    assert.ok(mirror.frames > 0 && mirror.width > 0 && mirror.height > 0, JSON.stringify(mirror));
    const canvas = page.locator('.phone-video');
    const controlAcks = Number(await canvas.getAttribute('data-control-acks'));
    const canvasBox = await canvas.boundingBox();
    assert.ok(canvasBox, '手机画面区域应可操作');
    await page.mouse.click(canvasBox.x + canvasBox.width / 2, canvasBox.y + 24);
    await page.waitForFunction((count) => Number(document.querySelector('.phone-video')?.getAttribute('data-control-acks')) >= count + 2, controlAcks);
    const clickAcks = Number(await canvas.getAttribute('data-control-acks'));
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2 - 30, { steps: 4 });
    await page.mouse.up();
    await page.waitForFunction((count) => Number(document.querySelector('.phone-video')?.getAttribute('data-control-acks')) >= count + 3, clickAcks);
    const dragAcks = Number(await canvas.getAttribute('data-control-acks'));
    await canvas.press('ArrowDown');
    await page.waitForFunction((count) => Number(document.querySelector('.phone-video')?.getAttribute('data-control-acks')) >= count + 2, dragAcks);
    const keyAcks = Number(await canvas.getAttribute('data-control-acks'));
    await canvas.press('A');
    await page.waitForFunction((count) => Number(document.querySelector('.phone-video')?.getAttribute('data-control-acks')) >= count + 1, keyAcks);
    const controlWrites = Number(await canvas.getAttribute('data-control-acks')) - controlAcks;
    const result = await page.evaluate((serial) => window.workbench.pages(serial), device.serial);
    assert.ok(result.pages.length > 0, '需要 APP 打开已启用调试的 WebView');
    await page.locator('.page-item').first().waitFor();
    assert.equal(await page.locator('.page-item').count(), result.pages.length);
    const candidateIndex = result.pages.findIndex((entry) => entry.candidate);
    assert.ok(candidateIndex >= 0, '需要唯一屏幕内候选页面');
    const candidate = result.pages[candidateIndex];
    assert.match(candidate.browser, /^Chrome\/\d+/);
    assert.match(candidate.protocolVersion, /^\d+\.\d+$/);
    assert.match(candidate.frontendRevision, /^[0-9a-f]{40}$/);
    const candidatePage = page.locator('.page-item').nth(candidateIndex);
    await page.waitForFunction((index) => document.querySelectorAll('.page-item')[index]?.getAttribute('aria-pressed') === 'true', candidateIndex);
    assert.equal(await page.locator('.follow-toggle').getAttribute('aria-pressed'), 'true');
    assert.ok((await page.locator('.inspector-version').textContent())?.includes(candidate.browser));
    await page.locator('.diagnostics-button').waitFor();
    await page.waitForFunction(() => Boolean(document.querySelector('.inspector-close')) || Boolean(document.querySelector('.inspector-error')?.textContent));
    const manualIndex = result.pages.findIndex((entry) => !entry.candidate);
    if (manualIndex >= 0) {
      const manualPage = page.locator('.page-item').nth(manualIndex);
      await manualPage.click();
      await page.waitForFunction((index) => document.querySelectorAll('.page-item')[index]?.getAttribute('aria-pressed') === 'true'
        && document.querySelector('.follow-toggle')?.getAttribute('aria-pressed') === 'false', manualIndex);
      await page.waitForFunction(() => Boolean(document.querySelector('.inspector-close')) || Boolean(document.querySelector('.inspector-error')?.textContent));
      await desktop.evaluate(({ webContents }) => {
        const contents = webContents.getAllWebContents().find((entry) => entry.getTitle() === 'DevTools' || /\/[0-9a-f]{40}\/inspector\.html(?:\?|$)/.test(entry.getURL()));
        if (!contents) throw new Error('锁定目标的 DevTools 应已打开');
        contents.forcefullyCrashRenderer();
      });
      await page.waitForFunction(() => document.querySelector('.inspector-error')?.textContent?.includes('已断开'));
      await page.waitForTimeout(1500);
      assert.equal(await desktop.evaluate(({ webContents }) => webContents.getAllWebContents()
        .filter((entry) => entry.getTitle() === 'DevTools' || /\/[0-9a-f]{40}\/inspector\.html(?:\?|$)/.test(entry.getURL())).length), 0,
      '锁定模式断线后不应自动重开 DevTools');
      await page.locator('.follow-toggle').click();
      await page.waitForFunction((index) => document.querySelectorAll('.page-item')[index]?.getAttribute('aria-pressed') === 'true'
        && document.querySelector('.follow-toggle')?.getAttribute('aria-pressed') === 'true', candidateIndex);
      await page.waitForFunction(() => Boolean(document.querySelector('.inspector-close')) || Boolean(document.querySelector('.inspector-error')?.textContent));
    }
    assert.equal(await candidatePage.getAttribute('aria-pressed'), 'true');
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
      return { ...state, id: contents.id, url: contents.getURL(), chrome: process.versions.chrome };
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
    const corePanels = [
      ['console', 'console'], ['sources', 'sources'], ['network', 'network'],
      ['show application', 'resources'], ['show performance', 'timeline'], ['show memory', 'heap-profiler'],
    ];
    for (const [command, panel] of corePanels) {
      assert.equal(await showDevToolsPanel(desktop, command, panel), true, 'DevTools 面板无法加载：' + panel);
    }
    await desktop.evaluate(({ webContents }, id) => {
      const contents = webContents.fromId(id);
      if (!contents) throw new Error('自动跟随的 DevTools 应仍存在');
      contents.forcefullyCrashRenderer();
    }, devtools.id);
    await page.waitForFunction(() => document.querySelector('.inspector-error')?.textContent?.includes('重连'));
    await page.waitForFunction(() => Boolean(document.querySelector('.inspector-close'))
      && !document.querySelector('.inspector-error')?.textContent, undefined, { timeout: 20000 });
    await page.waitForTimeout(4000);
    const recovered = await desktop.evaluate(async ({ webContents }, previousId) => {
      const contents = webContents.getAllWebContents().find((entry) => entry.id !== previousId
        && (entry.getTitle() === 'DevTools' || /\/[0-9a-f]{40}\/inspector\.html(?:\?|$)/.test(entry.getURL())));
      if (!contents) return { missing: true };
      const state = await contents.executeJavaScript('({ ready: document.readyState, hasUi: document.body?.id === "-blink-dev-tools" && document.body.childElementCount > 0, hasElementsPanel: Boolean(document.querySelector(".panel.elements")) })');
      return { ...state, id: contents.id };
    }, devtools.id);
    assert.ok(!('missing' in recovered), JSON.stringify(recovered));
    assert.notEqual(recovered.id, devtools.id);
    assert.equal(recovered.ready, 'complete');
    assert.equal(recovered.hasUi, true);
    assert.equal(recovered.hasElementsPanel, true, JSON.stringify(recovered));
    let stabilitySwitches = 0;
    if (process.argv.includes('--stability')) {
      assert.ok(manualIndex >= 0, '稳定性验证需要一个非候选 WebView');
      for (let cycle = 0; cycle < 10; cycle += 1) {
        assert.ok(await switchWorkbenchPage(page, desktop, manualIndex), '切换到锁定 WebView 超时');
        assert.ok(await switchWorkbenchPage(page, desktop, candidateIndex), '切换到候选 WebView 超时');
        stabilitySwitches += 2;
      }
      await page.waitForFunction(() => Boolean(document.querySelector('.inspector-close'))
        && !document.querySelector('.inspector-error')?.textContent, undefined, { timeout: 30000 });
      assert.equal((await currentDevTools(desktop)).count, 1, '压力切换后只允许一个 DevTools 视图');
      await page.locator('.follow-toggle').click();
      assert.equal(await page.locator('.follow-toggle').getAttribute('aria-pressed'), 'true');
    }
    console.log('WebView 真机验证通过：手机画面 ' + mirror.width + '×' + mirror.height + ' / ' + mirror.frames + ' 帧，触摸、拖动、键盘与文本控制写入 ' + controlWrites + ' 次，页面数量 ' + result.pages.length + '，屏幕内候选 ' + result.pages.filter((entry) => entry.candidate).length + '，7 个核心 DevTools 面板已加载并在断线后自动恢复' + (stabilitySwitches ? '，连续切换 ' + stabilitySwitches + ' 次后仍只有一个调试视图' : '') + '（Electron Chromium ' + devtools.chrome + '）。');
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
