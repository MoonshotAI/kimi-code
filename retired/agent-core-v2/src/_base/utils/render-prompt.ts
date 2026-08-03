/**
 * Shared prompt-template renderer (`renderPrompt`).
 *
 * A single `${var}` substitution pass: every variable present in `vars` is
 * replaced with its string value, unknown or non-string placeholders stay
 * verbatim, and a bare `$` is never special. There is no conditional or loop
 * syntax by design — call sites compose optional sections in code and pass
 * them as pre-rendered blocks. This keeps user-facing templates (agent files,
 * `SYSTEM.md`) safe to write: a literal `${...}` inside prose or a code
 * snippet can never crash rendering.
 */

const PROMPT_VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function renderPrompt(template: string, vars: Record<string, unknown>): string {
  return template.replace(PROMPT_VARIABLE, (match: string, name: string) => {
    const value = vars[name];
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return match;
  });
}
