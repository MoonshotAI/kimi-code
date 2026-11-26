
const QUERY_KEY = 'kimi_desktop';
const PLATFORM_KEY = 'platform';
const NATIVE_TITLEBAR_KEY = 'kimi_native_titlebar';
const STORAGE_KEY = 'kimi-desktop';
const PLATFORM_STORAGE_KEY = 'kimi-desktop-platform';
const NATIVE_TITLEBAR_STORAGE_KEY = 'kimi-native-titlebar';

interface DesktopEnv {
  isDesktop: boolean;
  platform: string | null;
  nativeTitleBar: boolean;
}

export function hasDesktopBridge(): boolean {
  return (globalThis as { kimiDesktop?: unknown }).kimiDesktop !== undefined ||
    (typeof window !== 'undefined' && (window as { kimiDesktop?: unknown }).kimiDesktop !== undefined);
}

export function sessionLinksSupported(): boolean {
  type Bridge = { kimiDesktop?: { sessionLinksSupported?: unknown } };
  const bridge = (globalThis as Bridge).kimiDesktop ?? (typeof window === 'undefined' ? undefined : (window as Bridge).kimiDesktop);
  return bridge?.sessionLinksSupported === true;
}

function detect(): DesktopEnv {
  let desktop = typeof __KIMI_CODE_DESKTOP__ !== 'undefined' ? __KIMI_CODE_DESKTOP__ : false;
  let platform: string | null = null;
  let nativeTitleBar = false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has(QUERY_KEY)) {
      sessionStorage.setItem(STORAGE_KEY, '1');
      desktop = true;
    } else {
      desktop = desktop || sessionStorage.getItem(STORAGE_KEY) === '1';
    }
    const qPlatform = params.get(PLATFORM_KEY);
    if (qPlatform) {
      sessionStorage.setItem(PLATFORM_STORAGE_KEY, qPlatform);
      platform = qPlatform;
    } else {
      platform = sessionStorage.getItem(PLATFORM_STORAGE_KEY);
    }
    const qNativeTitleBar = params.get(NATIVE_TITLEBAR_KEY);
    if (qNativeTitleBar) {
      sessionStorage.setItem(NATIVE_TITLEBAR_STORAGE_KEY, qNativeTitleBar);
      nativeTitleBar = qNativeTitleBar === '1';
    } else {
      nativeTitleBar = sessionStorage.getItem(NATIVE_TITLEBAR_STORAGE_KEY) === '1';
    }
  } catch {}
  return { isDesktop: desktop, platform, nativeTitleBar };
}

const env = detect();

export const isDesktop = env.isDesktop;

export const isMacosDesktop = env.isDesktop && env.platform === 'darwin';

export const isWindowsDesktop = env.isDesktop && env.platform === 'win32';

export const isLinuxDesktop = env.isDesktop && env.platform === 'linux';

export const prefersNativeTitleBar = env.nativeTitleBar;

export const hasCustomTitleBar = isWindowsDesktop || (isLinuxDesktop && !env.nativeTitleBar);
