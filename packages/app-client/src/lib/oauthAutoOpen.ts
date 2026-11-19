
export interface OAuthAutoOpenDriver {
  onGesture?(): void;
  openUrl(url: string, flowId: string): boolean | Promise<boolean>;
  settle(ok: boolean, opts?: { keepNavigated?: boolean }): void;
}

export interface AutoOpenTab {
  readonly closed: boolean;
  navigate(url: string): void;
  focus(): void;
  close(): void;
}

export function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function defaultOpenTab(): AutoOpenTab | null {
  const win = window.open('', '_blank');
  if (!win) return null;
  try { win.opener = null; } catch {}
  return {
    get closed() { return win.closed; },
    navigate(url) { win.location.href = url; },
    focus() { win.focus(); },
    close() { win.close(); },
  };
}

export function createWebOAuthAutoOpen(
  openTab: () => AutoOpenTab | null = defaultOpenTab,
): OAuthAutoOpenDriver {
  let tab: AutoOpenTab | null = null;
  let navigatedUrl: string | null = null;

  function closeTab(): void {
    if (tab) {
      try { tab.close(); } catch {}
    }
    tab = null;
    navigatedUrl = null;
  }

  return {
    onGesture() {
      closeTab();
      tab = openTab();
    },
    openUrl(url, _flowId) {
      if (!isHttpUrl(url)) { closeTab(); return false; }
      if (!tab || tab.closed) { tab = null; navigatedUrl = null; return false; }
      if (navigatedUrl === url) {
        try { tab.focus(); } catch {}
        return true;
      }
      try { tab.navigate(url); } catch { closeTab(); return false; }
      navigatedUrl = url;
      return true;
    },
    settle(ok, opts) {
      if (navigatedUrl !== null && (ok || opts?.keepNavigated === true)) {
        tab = null;
        navigatedUrl = null;
        return;
      }
      closeTab();
    },
  };
}

interface OpenExternalBridge {
  openExternal?: (url: string) => Promise<void>;
}

export function createDesktopOAuthAutoOpen(wrapUrl: (url: string) => string): OAuthAutoOpenDriver {
  let lastOpened: { flowId: string; result: Promise<boolean> } | null = null;
  return {
    openUrl(url, flowId) {
      if (lastOpened?.flowId === flowId) return lastOpened.result;
      const wrapped = wrapUrl(url);
      if (!isHttpUrl(wrapped)) return false;
      const bridge = (window as { kimiDesktop?: OpenExternalBridge }).kimiDesktop;
      if (!bridge?.openExternal) return false;
      let result: Promise<boolean>;
      try {
        result = bridge.openExternal(wrapped).then(
          () => true,
          () => false,
        );
      } catch {
        return false;
      }
      lastOpened = { flowId, result };
      void result.then((ok) => {
        if (!ok && lastOpened?.flowId === flowId) lastOpened = null;
      });
      return result;
    },
    settle() {},
  };
}
