import type { DesktopApp } from './app';

export async function captureClipboardWrites(app: DesktopApp): Promise<() => Promise<string[]>> {
  await app.electron.evaluate(({ clipboard }) => {
    const writes: string[] = [];
    (globalThis as { __kimiE2eClipboardWrites?: string[] }).__kimiE2eClipboardWrites = writes;
    clipboard.writeText = async (text: string) => { writes.push(text); };
  });
  await app.window.evaluate(() => {
    const bridge = (globalThis as unknown as { kimiDesktop: { writeClipboardText: (text: string) => Promise<boolean> } }).kimiDesktop;
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async (text: string) => { await bridge.writeClipboardText(text); },
    });
  });
  return () => app.electron.evaluate(() => [...((globalThis as { __kimiE2eClipboardWrites?: string[] }).__kimiE2eClipboardWrites ?? [])]);
}
