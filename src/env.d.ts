import type { DeviceList } from '../electron/services/devices.mjs';
import type { PageList } from '../electron/services/webviews.mjs';

export {};

declare global {
  interface Window {
    workbench?: {
      devices(): Promise<DeviceList>;
      chooseAdb(): Promise<boolean>;
      pages(serial: string): Promise<PageList>;
      inspector: {
        open(targetId: string, bounds: DOMRectLike): Promise<{ ok: boolean; error: string | null }>;
        bounds(bounds: DOMRectLike): Promise<boolean>;
        close(): Promise<void>;
      };
    };
  }
}

interface DOMRectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}
