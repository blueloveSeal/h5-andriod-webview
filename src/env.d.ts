import type { DeviceList } from '../electron/services/devices.mjs';
import type { PageList } from '../electron/services/webviews.mjs';

export {};

declare global {
  interface Window {
    workbench?: {
      devices(): Promise<DeviceList>;
      chooseAdb(): Promise<boolean>;
      pages(serial: string): Promise<PageList>;
    };
  }
}
