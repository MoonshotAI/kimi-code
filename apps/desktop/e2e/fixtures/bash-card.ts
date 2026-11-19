import type { Locator } from '@playwright/test';

export function toolCard(transcript: Locator, command: string): Locator {
  return transcript
    .getByRole('list')
    .getByRole('listitem')
    .filter({ hasText: command })
    .filter({ has: transcript.page().getByRole('button', { name: /^(Expand|Collapse) details$/ }) });
}

export function cardOutput(card: Locator): Locator {
  return card.locator('.op');
}

export const gateFile = (name: string): string => `.e2e-gate-${name}`;

export const readyFile = (name: string): string => `.e2e-ready-${name}`;

export function gatedLoop(name: string, before: readonly string[], after: readonly string[], signalReady = false): string {
  const print = (lines: readonly string[]) => lines.map(line => `echo ${line}`).join('; ');
  const ready = signalReady ? `; touch ${readyFile(name)}` : '';
  return `${print(before)}${ready}; while [ ! -f ${gateFile(name)} ]; do sleep 0.1; done; ${print(after)}`;
}
