/**
 * Lightweight prompt template renderer — local port of the retired
 * `agent-core/utils/render-prompt` for the small nunjucks subset the system
 * prompt templates use: `{{ var }}` interpolation and `{% if X %}...{% endif %}`
 * truthiness blocks. No nunjucks dependency.
 *
 * - Missing variables are a loud error (never a leaked `{{ placeholder }}`).
 * - `if` blocks render their body only when the variable is truthy and
 *   non-empty.
 */

export function renderPrompt(template: string, vars: Record<string, unknown>): string {
  // Interpolate `{{ name }}` first.
  let out = template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      throw new Error(`Missing template variable: ${name}`);
    }
    return stringifyTemplateValue(value);
  });

  // Then resolve `{% if NAME %}...{% endif %}` truthiness blocks.
  for (;;) {
    const open = /\{%\s*if\s+([A-Za-z0-9_]+)\s*%\}/.exec(out);
    if (open === null) break;
    const close = /\{%\s*endif\s*%\}/.exec(out.slice(open.index + open[0].length));
    if (close === null) {
      throw new Error(`Unterminated {% if %} block for "${open[1]}"`);
    }
    const bodyStart = open.index + open[0].length;
    const bodyEnd = bodyStart + close.index;
    const body = out.slice(bodyStart, bodyEnd);
    const value = vars[open[1]!];
    const truthy = value !== undefined && value !== '' && value !== false && value !== null;
    out = out.slice(0, open.index) + (truthy ? body : '') + out.slice(bodyEnd + close[0].length);
  }

  return out;
}

function stringifyTemplateValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}
