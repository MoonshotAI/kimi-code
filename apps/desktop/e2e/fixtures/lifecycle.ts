import type { WebSocketRoute } from '@playwright/test';

import type { DesktopApp } from './app';

export async function enableQuitConfirm(app: DesktopApp): Promise<void> {
  await app.electron.evaluate(() => {
    process.env['KIMI_DESKTOP_E2E'] = 'quit-confirm';
  });
}

export async function clickAppMenu(app: DesktopApp, label: string): Promise<void> {
  const found = await app.electron.evaluate(({ app: electronApp, Menu }, wanted) => {
    const visit = (items: readonly Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.label === wanted) return item;
        const nested = item.submenu === null || item.submenu === undefined ? undefined : visit(item.submenu.items);
        if (nested !== undefined) return nested;
      }
      return undefined;
    };
    const item = visit(Menu.getApplicationMenu()?.items ?? []);
    if (item === undefined) return false;
    setImmediate(() => {
      if (item.role?.toLowerCase() === 'quit') electronApp.quit();
      else item.click();
    });
    return true;
  }, label);
  if (!found) throw new Error(`The application menu has no "${label}" item`);
}

const SERVER_API = /^https?:\/\/(127\.0\.0\.1|localhost):\d+\/api\/v1\//;
const SERVER_SOCKET = /^wss?:\/\/(127\.0\.0\.1|localhost):\d+\/api\/v1\//;

export interface Outage {
  readonly down: () => Promise<void>;
  readonly up: () => void;
}

export async function routeServerTraffic(app: DesktopApp): Promise<Outage> {
  const sockets = new Set<WebSocketRoute>();
  let offline = false;
  await app.window.routeWebSocket(SERVER_SOCKET, (socket) => {
    if (offline) {
      void socket.close({ code: 1011, reason: 'e2e outage' });
      return;
    }
    socket.connectToServer();
    sockets.add(socket);
  });
  await app.window.route(SERVER_API, (route) => {
    if (!offline) return route.continue();
    return route.abort('connectionrefused');
  });
  return {
    down: async () => {
      offline = true;
      const open = [...sockets];
      sockets.clear();
      await Promise.all(open.map(socket => socket.close({ code: 1011, reason: 'e2e outage' }).catch(() => undefined)));
    },
    up: () => { offline = false; },
  };
}
