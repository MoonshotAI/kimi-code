import { log } from '../diagnostics/log';
import { getRemoteControlRestoreState, type RemoteControlRestoreState } from '../app/ui-state';

const RESTORE_TIMEOUT_MS = 10_000;

export function shouldRestoreRemoteControl(state: RemoteControlRestoreState): boolean {
  return state.restoreEnabled && state.previousEnabled;
}

export async function restoreRemoteControlOnStartup(
  origin: string,
  token: string | undefined,
  fetcher: typeof fetch = fetch,
  onFinished: () => void = () => {},
): Promise<void> {
  if (!shouldRestoreRemoteControl(getRemoteControlRestoreState())) return;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token !== undefined) headers['Authorization'] = `Bearer ${token}`;
  try {
    const response = await fetcher(`${origin}/api/v1/remote-control`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabled: true }),
      signal: AbortSignal.timeout(RESTORE_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => null)) as {
      code?: unknown;
      msg?: unknown;
    } | null;
    if (!response.ok) {
      const message = typeof payload?.msg === 'string' ? payload.msg : `HTTP ${response.status}`;
      throw new Error(message);
    }
    if (typeof payload?.code !== 'number') throw new Error('Invalid response');
    if (payload.code !== 0) {
      const message = typeof payload.msg === 'string' ? payload.msg : `code ${payload.code}`;
      throw new Error(message);
    }
  } catch (error) {
    log.warn(
      `[kimi-desktop] failed to restore Remote Control state: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    onFinished();
  }
}
