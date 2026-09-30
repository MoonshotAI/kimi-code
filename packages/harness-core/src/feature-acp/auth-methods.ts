import type { AuthMethod } from '@agentclientprotocol/sdk';

export function buildTerminalAuthMethod(
  opts: {
    env?: Readonly<Record<string, string>>;
    legacyCommand?: string;
  } = {},
): AuthMethod {
  const env = opts.env ?? {};
  const method: AuthMethod = {
    id: 'login',
    type: 'terminal',
    name: 'Login with Kimi account',
    description: 'Open the device-code login flow in a terminal.',
    args: ['--login'],
    env: { ...env },
  };
  if (opts.legacyCommand !== undefined && opts.legacyCommand.length > 0) {
    (method as AuthMethod & { _meta: { 'terminal-auth': unknown } })._meta = {
      'terminal-auth': {
        type: 'terminal',
        label: 'Login with Kimi account',
        command: opts.legacyCommand,
        args: ['login'],
        env: { ...env },
      },
    };
  }
  return method;
}

export const TERMINAL_AUTH_METHOD: AuthMethod = buildTerminalAuthMethod();
