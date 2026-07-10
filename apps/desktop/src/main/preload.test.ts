import { describe, it, expect, vi, beforeEach } from 'vitest';

const expose = vi.fn();
const send = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();
const invoke = vi.fn().mockResolvedValue(undefined);

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { send, on, removeListener, invoke },
}));

beforeEach(() => {
  expose.mockClear(); send.mockClear(); on.mockClear(); removeListener.mockClear(); invoke.mockClear();
});

it('exposes kimiDesktop via contextBridge with the expected surface', async () => {
  await import('./preload');
  expect(expose).toHaveBeenCalledOnce();
  const [name, exposed] = expose.mock.calls[0]!;
  expect(name).toBe('kimiDesktop');
  expect(Object.keys(exposed).sort()).toEqual(['onMenu', 'openExternal', 'setTheme']);
  exposed.setTheme('dark');
  expect(send).toHaveBeenCalledWith('kimi:theme', 'dark');
  exposed.setTheme('bogus');
  expect(send).toHaveBeenCalledTimes(1); // ignored invalid scheme
  const off = exposed.onMenu(() => {});
  expect(on).toHaveBeenCalledWith('kimi:menu', expect.any(Function));
  off();
  expect(removeListener).toHaveBeenCalledWith('kimi:menu', expect.any(Function));
  await exposed.openExternal('https://example.com');
  expect(invoke).toHaveBeenCalledWith('kimi:open-external', 'https://example.com');
});
