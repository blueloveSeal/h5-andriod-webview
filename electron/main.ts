import { app, BrowserWindow, dialog, ipcMain, net, WebContentsView } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDevices } from './services/devices.mjs';
import { WebViewDiscovery } from './services/webviews.mjs';
import { inspectorBounds, inspectorUrl, startInspectorFrontend } from './services/inspector.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | null = null;
let inspectorView: WebContentsView | null = null;
let inspectorTargetId = '';
let inspectorFrontend: Awaited<ReturnType<typeof startInspectorFrontend>> | null = null;
let adbPath = process.env.WEBVIEW_ADB_PATH || 'adb';
const discovery = new WebViewDiscovery({ adb: () => adbPath });
let cleanupDone = false;

// 验证时隔离本工具的数据目录，避免测试影响正常使用。
if (process.env.WEBVIEW_TEST_DATA) app.setPath('userData', process.env.WEBVIEW_TEST_DATA);
app.setName('WebView 工作台');
app.setAppUserModelId('dev.blueloveseal.webview-workbench');

function trusted(event: Electron.IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('请求来源无效');
  }
}

function closeInspector() {
  if (!inspectorView) return;
  window?.contentView.removeChildView(inspectorView);
  inspectorView.webContents?.close({ waitForBeforeUnload: false });
  inspectorView = null;
  inspectorTargetId = '';
}

function updateInspectorBounds(value: unknown) {
  if (!window || !inspectorView) return false;
  const bounds = inspectorBounds(value, window.getContentBounds());
  if (!bounds) return false;
  inspectorView.setBounds(bounds);
  return true;
}

async function waitForInspector(contents: Electron.WebContents, baseUrl: string, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && !contents.isDestroyed() && contents.getURL().startsWith(baseUrl)) {
    const ready = await contents.executeJavaScript(
      'document.readyState === "complete" && document.body?.id === "-blink-dev-tools" && document.body.childElementCount > 0',
    ).catch(() => false);
    if (ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function createWindow() {
  inspectorFrontend = await startInspectorFrontend({ fetcher: net.fetch });
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: 'WebView 工作台',
    backgroundColor: '#101512',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(directory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.once('ready-to-show', () => window?.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('closed', () => { inspectorView = null; inspectorTargetId = ''; window = null; });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) await window.loadURL(devUrl);
  else await window.loadFile(path.join(directory, '../dist/index.html'));
}

ipcMain.handle('devices:list', (event) => {
  trusted(event);
  return listDevices(adbPath);
});

ipcMain.handle('settings:choose-adb', async (event) => {
  trusted(event);
  const choice = await dialog.showOpenDialog(window!, {
    title: '选择 Android Platform Tools 中的 adb.exe',
    properties: ['openFile'],
    filters: [{ name: 'ADB', extensions: ['exe'] }],
  });
  if (choice.canceled || !choice.filePaths[0]) return false;
  if (path.basename(choice.filePaths[0]).toLowerCase() !== 'adb.exe') return false;
  adbPath = choice.filePaths[0];
  return true;
});

ipcMain.handle('webviews:list', async (event, serial: unknown) => {
  trusted(event);
  if (typeof serial !== 'string') throw new Error('设备参数无效');
  const result = await listDevices(adbPath);
  const available = result.devices.some((device) => device.serial === serial && device.state === 'device');
  return discovery.scan(available ? serial : '');
});

ipcMain.handle('inspector:open', async (event, targetId: unknown, boundsValue: unknown) => {
  trusted(event);
  if (typeof targetId !== 'string') return { ok: false, error: '调试页面参数无效。' };
  const target = discovery.target(targetId);
  if (!target) return { ok: false, error: '页面已失效，请刷新后重试。' };
  if (inspectorView && inspectorTargetId === targetId) {
    return updateInspectorBounds(boundsValue) ? { ok: true, error: null } : { ok: false, error: '调试区域尺寸无效。' };
  }
  closeInspector();
  const bounds = window && inspectorBounds(boundsValue, window.getContentBounds());
  const frontend = inspectorFrontend;
  if (!window || !bounds || !frontend) return { ok: false, error: '调试区域或前端服务不可用。' };
  const frontendEntry = target.frontend && frontend.entry(target.frontend);
  if (!frontendEntry) return { ok: false, error: '设备未提供兼容的 DevTools 前端。' };
  const relayEndpoint = frontend.relay(target.endpoint);
  if (!relayEndpoint) return { ok: false, error: '设备调试连接无效，请刷新页面后重试。' };
  const frontendRoot = frontendEntry.slice(0, frontendEntry.lastIndexOf('/') + 1);
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const contents = view.webContents;
  view.setBounds(bounds);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (navigationEvent, url) => {
    if (!url.startsWith(frontendRoot)) navigationEvent.preventDefault();
  });
  if (process.env.WEBVIEW_TEST_DATA) {
    contents.on('console-message', (details) => {
      console.error('[inspector-console] ' + details.level + ':' + details.message.slice(0, 500));
    });
    contents.on('did-fail-load', (_event, code, description, url) => {
      console.error('[inspector] did-fail-load=' + code + ':' + description + ':' + new URL(url).pathname);
    });
    contents.on('render-process-gone', (_event, details) => {
      console.error('[inspector] render-process-gone=' + details.reason + ':' + details.exitCode);
    });
    contents.on('destroyed', () => console.error('[inspector] destroyed'));
  }
  window.contentView.addChildView(view);
  inspectorView = view;
  inspectorTargetId = targetId;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      contents.loadURL(inspectorUrl(relayEndpoint, frontendEntry)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('DevTools 加载超时')), 15000);
      }),
    ]).finally(() => clearTimeout(timer));
    if (await waitForInspector(contents, frontendRoot)) return { ok: true, error: null };
    throw new Error('DevTools 页面未就绪');
  } catch (error) {
    const frontendReady = inspectorView === view && await waitForInspector(contents, frontendRoot);
    if (frontendReady) return { ok: true, error: null };
    if (process.env.WEBVIEW_TEST_DATA) {
      const detail = error instanceof Error ? error.message : '未知加载错误';
      console.error('[inspector] ' + detail.slice(0, 200));
      const current = contents.isDestroyed() ? 'destroyed' : new URL(contents.getURL()).pathname;
      console.error('[inspector] current=' + current);
      if (!contents.isDestroyed()) {
        const state = await contents.executeJavaScript(
          '({ bodyId: document.body?.id, children: document.body?.childElementCount, resources: performance.getEntriesByType("resource").map((entry) => new URL(entry.name).pathname).slice(-12) })',
        ).catch(() => null);
        console.error('[inspector] state=' + JSON.stringify(state));
      }
    }
    closeInspector();
    const detail = error instanceof Error ? error.message : '';
    const code = detail === 'DevTools 加载超时' ? 'TIMEOUT' : detail.match(/ERR_[A-Z_]+/)?.[0];
    return { ok: false, error: code === 'TIMEOUT'
      ? 'DevTools 加载超时，请刷新页面后重试。'
      : 'DevTools 加载失败' + (code ? '（' + code + '）' : '') + '，请确认页面仍然打开。' };
  }
});

ipcMain.handle('inspector:bounds', (event, boundsValue: unknown) => {
  trusted(event);
  return updateInspectorBounds(boundsValue);
});

ipcMain.handle('inspector:close', (event) => {
  trusted(event);
  closeInspector();
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.whenReady().then(createWindow).catch(() => {
    dialog.showErrorBox('启动失败', '无法加载工作台，请先运行 npm run build。');
    app.quit();
  });
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (cleanupDone) return;
  event.preventDefault();
  closeInspector();
  void Promise.all([discovery.close(), inspectorFrontend?.close()]).finally(() => {
    inspectorFrontend = null;
    cleanupDone = true;
    app.quit();
  });
});
