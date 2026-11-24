import type { ConfirmOptions } from '@moonshot-ai/app-client/composables';
import type { Translator } from '@moonshot-ai/app-core/contracts';
import type { TerminalActivity } from '../../shared/terminal-activity';

export interface ClosingTerminalTab {
  id: string;
  title: string;
  ptyId?: string;
}

export function createTerminalCloseGuard(options: {
  inspect: (ids: string[]) => Promise<TerminalActivity[]>;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  t: Translator;
}) {
  let pending = false;
  return async (tabs: ClosingTerminalTab[]): Promise<boolean> => {
    if (pending) return false;
    const terminals = tabs.filter(tab => tab.ptyId !== undefined);
    if (terminals.length === 0) return true;
    pending = true;
    try {
      let activity: TerminalActivity[] = [];
      try { activity = await options.inspect(terminals.map(tab => tab.ptyId!)); }
      catch { activity = []; }
      const blocked = terminals.flatMap(tab => {
        const state = activity.find(item => item.id === tab.ptyId);
        if (state?.state === 'idle' || state?.state === 'exited') return [];
        const processes = state?.state === 'busy'
          ? state.processes.map(process => `${process.binary} (PID ${process.pid})`).join(', ')
          : options.t('terminal.closeUnknown');
        return [`${tab.title}\n${processes}${state?.cwd ? `\n${state.cwd}` : ''}`];
      });
      if (blocked.length === 0) return true;
      return await options.confirm({
        title: options.t('terminal.closeRunningTitle'),
        message: `${options.t('terminal.closeRunningMessage')}\n\n${blocked.join('\n\n')}`,
        confirmLabel: options.t('terminal.closeRunningConfirm'),
        cancelLabel: options.t('common.cancel'),
        variant: 'danger',
      });
    } finally { pending = false; }
  };
}
