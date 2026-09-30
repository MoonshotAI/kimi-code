import { LLM_NOT_SET_MESSAGE } from '../constant/kimi-tui';
import type { SlashCommandHost } from './dispatch';

export async function handleBtwCommand(host: SlashCommandHost, args: string): Promise<void> {
  const prompt = args.trim();
  if (prompt.length === 0) {
    host.showStatus('Provide a side question, e.g. `/btw What does this function do?`');
    return;
  }
  if (host.state.appState.model.trim().length === 0) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }
  host.btwPanelController.closeOrCancel();
  await host.askBtw(prompt);
}
