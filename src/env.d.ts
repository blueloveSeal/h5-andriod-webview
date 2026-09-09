import type { DeviceList } from '../electron/services/devices.mjs';

export {};

declare global {
  interface Window {
    workbench?: {
      devices(): Promise<DeviceList>;
      chooseAdb(): Promise<boolean>;
    };
  }
}
