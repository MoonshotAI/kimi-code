import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

export async function handleRuntimeCommand(host: SlashCommandHost, rawArgs: string): Promise<void> {
  const session = await host.ensureSession();
  if (session === undefined) return;
  const runtimeId = rawArgs.trim();
  try {
    const binding = runtimeId.length === 0
      ? await session.getRuntime()
      : await session.switchRuntime(runtimeId);
    host.showStatus(`Runtime: ${binding.runtimeId}`);
  } catch (error) {
    host.showError(`Failed to switch runtime: ${formatErrorMessage(error)}`);
  }
}
