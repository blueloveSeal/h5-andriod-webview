import { contextBridge, ipcRenderer } from 'electron';

// 只暴露固定业务接口，不向页面暴露通用 IPC 或 Node 能力。
contextBridge.exposeInMainWorld('workbench', {
  devices: () => ipcRenderer.invoke('devices:list'),
  chooseAdb: () => ipcRenderer.invoke('settings:choose-adb'),
  pages: (serial: string) => ipcRenderer.invoke('webviews:list', serial),
});
