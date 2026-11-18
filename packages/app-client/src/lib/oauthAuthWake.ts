
export interface OAuthAuthWakeDriver {
  subscribe(run: () => void): () => void;
}

interface DeepLinkAuthBridge {
  onDeepLinkAuth?: (cb: () => void) => () => void;
}

export function createDesktopAuthWake(): OAuthAuthWakeDriver {
  return {
    subscribe(run) {
      const unsubs: Array<() => void> = [];
      const bridge = (window as { kimiDesktop?: DeepLinkAuthBridge }).kimiDesktop;
      if (bridge?.onDeepLinkAuth) {
        try {
          unsubs.push(bridge.onDeepLinkAuth(run));
        } catch {}
      }
      window.addEventListener('focus', run);
      unsubs.push(() => window.removeEventListener('focus', run));
      return () => {
        for (const unsub of unsubs.splice(0)) unsub();
      };
    },
  };
}

export function createWebAuthWake(): OAuthAuthWakeDriver {
  return {
    subscribe(run) {
      const onVisibilityChange = () => {
        if (document.visibilityState === 'visible') run();
      };
      window.addEventListener('focus', run);
      document.addEventListener('visibilitychange', onVisibilityChange);
      return () => {
        window.removeEventListener('focus', run);
        document.removeEventListener('visibilitychange', onVisibilityChange);
      };
    },
  };
}
