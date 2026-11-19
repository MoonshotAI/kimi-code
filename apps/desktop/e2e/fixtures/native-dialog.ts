import type { DesktopApp, NativeCall } from './app';

export async function answerNativeDialog(app: DesktopApp, api: string, answer: unknown): Promise<void> {
  await app.electron.evaluate((_electron, entry) => {
    (globalThis as { __kimiE2eScriptedAnswers?: unknown[] }).__kimiE2eScriptedAnswers?.push(entry);
  }, { api, answer });
}

export async function answeredNativeCalls(app: DesktopApp): Promise<NativeCall[]> {
  return app.electron.evaluate(() => [...((globalThis as { __kimiE2eAnsweredCalls?: NativeCall[] }).__kimiE2eAnsweredCalls ?? [])]);
}
