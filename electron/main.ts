import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDevices } from './services/devices.mjs';
import { WebViewDiscovery } from './services/webviews.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | null = null;
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

async function createWindow() {
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
  window.on('closed', () => { window = null; });
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
  void discovery.close().finally(() => { cleanupDone = true; app.quit(); });
});
