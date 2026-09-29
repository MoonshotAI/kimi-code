const PROMPT_VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function renderPrompt(template: string, vars: Record<string, unknown>): string {
  return template.replace(PROMPT_VARIABLE, (match: string, name: string) => {
    const value = vars[name];
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return match;
  });
}
