// packages/app-client/src/lib/oauthAuthWake.ts
// Auth-wake drivers for the OAuth device-flow waiting page, plugged into
// useOAuthLoginFlow as the `authWake` option. One contract, two platforms.
// While the flow waits for the user to authorize in the browser, the
// composable only asks the daemon for the flow snapshot at the
// server-suggested interval (~5s); a wake signal means "the user is back from
// the authorization page" and makes it poll immediately:
//
// - desktop: the authorization completion page re-opens the app through the
//   `kimi-code://auth/success` deep link, which the main process forwards
//   over IPC (preload bridge `onDeepLinkAuth`). A window `focus` listener
//   rides along: the deep link focuses the window anyway, and focus alone
//   also covers the user switching back to the app by hand.
// - web: a browser tab can't be deep-linked, so the wake signals are simply
//   the window regaining `focus` or the tab becoming visible again
//   (`visibilitychange`) — both fire when the user switches back from the
//   authorization tab.

/** How the flow composable receives platform wake signals. */
export interface OAuthAuthWakeDriver {
  /** Registers the wake callback and returns its unsubscribe. The composable
      subscribes while a device-code flow waits and unsubscribes on every
      terminal state, cancel, and scope dispose. */
  subscribe(run: () => void): () => void;
}

/** Subset of the preload `kimiDesktop` bridge this driver needs. Older
    desktop builds without `onDeepLinkAuth` probe as absent and degrade to
    the plain focus listener. */
interface DeepLinkAuthBridge {
  onDeepLinkAuth?: (cb: () => void) => () => void;
}

/** Desktop driver: the main process's deep-link IPC plus window focus (see
    the file header). */
export function createDesktopAuthWake(): OAuthAuthWakeDriver {
  return {
    subscribe(run) {
      const unsubs: Array<() => void> = [];
      const bridge = (window as { kimiDesktop?: DeepLinkAuthBridge }).kimiDesktop;
      if (bridge?.onDeepLinkAuth) {
        try {
          unsubs.push(bridge.onDeepLinkAuth(run));
        } catch {
          // A throwing bridge must not break the login flow — focus remains.
        }
      }
      window.addEventListener('focus', run);
      unsubs.push(() => window.removeEventListener('focus', run));
      return () => {
        for (const unsub of unsubs.splice(0)) unsub();
      };
    },
  };
}

/** Web driver: window focus plus tab visibility (see the file header). */
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
