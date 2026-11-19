import type { DesktopApp } from './app';

type SendCommand = (this: Electron.Debugger, method: string, params?: { enabled?: boolean }, sessionId?: string) => Promise<unknown>;

interface InterceptionGate {
  failures: number;
  restore: Array<() => void>;
}

export async function failFileChooserInterceptionRelease(app: DesktopApp): Promise<{ failures: () => Promise<number>; restore: () => Promise<void> }> {
  await app.electron.evaluate(({ webContents }) => {
    const state: InterceptionGate = { failures: 0, restore: [] };
    (globalThis as { __kimiE2eInterceptionGate?: InterceptionGate }).__kimiE2eInterceptionGate = state;
    for (const contents of webContents.getAllWebContents()) {
      const target = contents.debugger;
      const own = Object.getOwnPropertyDescriptor(target, 'sendCommand');
      const original = target.sendCommand.bind(target) as SendCommand;
      const wrapped: SendCommand = function (method, params, sessionId) {
        if (method === 'Page.setInterceptFileChooserDialog' && params?.enabled === false) {
          state.failures += 1;
          return Promise.reject(new Error('e2e: file chooser interception is still being turned off'));
        }
        return original.call(this, method, params, sessionId);
      };
      Object.defineProperty(target, 'sendCommand', { value: wrapped, configurable: true, writable: true });
      state.restore.push(() => {
        if (own === undefined) Reflect.deleteProperty(target, 'sendCommand');
        else Object.defineProperty(target, 'sendCommand', own);
      });
    }
  });
  return {
    failures: () => app.electron.evaluate(() => (globalThis as { __kimiE2eInterceptionGate?: InterceptionGate }).__kimiE2eInterceptionGate?.failures ?? 0),
    restore: () => app.electron.evaluate(() => {
      for (const undo of (globalThis as { __kimiE2eInterceptionGate?: InterceptionGate }).__kimiE2eInterceptionGate?.restore ?? []) undo();
    }),
  };
}
