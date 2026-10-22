import { analyzeBashCommandSource } from '../analyzers/bash-danger';
import { isDangerousCommandGuardEnabled } from '../state/configSection';

import type { PermissionPolicy } from './chain';

export const dangerousCommandAsk: PermissionPolicy = {
  name: 'dangerous-command-ask',
  evaluate(context) {
    if (!isDangerousCommandGuardEnabled(context.config)) return undefined;
    if (context.mode === 'auto') return undefined;
    if (context.toolCall.name !== 'Bash') return undefined;
    const command = bashCommandText(context.args);
    const verdict =
      command === undefined
        ? ({ kind: 'unanalyzable' } as const)
        : analyzeBashCommandSource(command);
    if (verdict === undefined) return undefined;
    return { kind: 'ask' };
  },
};

function bashCommandText(args: Record<string, unknown> | undefined): string | undefined {
  const command = args?.['command'];
  return typeof command === 'string' ? command : undefined;
}
