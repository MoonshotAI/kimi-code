export interface ScreenshotGuidance {
  captureId: string;
  locale: 'en' | 'zh';
  platform: string;
  appName: string;
  kind: 'permission' | 'restricted' | 'capture';
  phase: 'idle' | 'checking' | 'ready';
  canRequest: boolean;
  canRevealApp: boolean;
  settingsOpened: boolean;
  notice: 'none' | 'settings-failed' | 'not-ready';
  reason: string;
}

export type ScreenshotGuidanceAction = 'settings' | 'check' | 'request' | 'reveal' | 'continue' | 'restart' | 'cancel';

export interface ScreenshotGuidanceBridge {
  getScreenshotGuidance: () => Promise<ScreenshotGuidance | null>;
  onScreenshotGuidance: (cb: (guide: ScreenshotGuidance | null) => void) => () => void;
  screenshotGuidanceAction: (captureId: string, action: ScreenshotGuidanceAction) => Promise<void>;
}
