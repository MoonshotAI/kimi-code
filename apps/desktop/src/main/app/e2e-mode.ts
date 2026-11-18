import { app } from 'electron';

export function e2eWindowMode(): 'visible' | 'quiet' | null {
  if (app.isPackaged) return null;
  const mode = process.env['KIMI_DESKTOP_E2E'];
  return mode === 'quiet' ? 'quiet' : mode === '1' ? 'visible' : null;
}
