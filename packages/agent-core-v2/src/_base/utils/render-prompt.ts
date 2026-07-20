/**
 * Shared prompt-template renderer (`renderPrompt`).
 */

import nunjucks from 'nunjucks';

const env = new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: true });

export function renderPrompt(template: string, vars: Record<string, unknown>): string {
  return env.renderString(template, vars);
}
