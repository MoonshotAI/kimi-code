import nunjucks from 'nunjucks';

/**
 * Shared prompt template renderer.
 *
 * All prompt templates (system prompt, tool descriptions, compaction
 * instruction, ...) use nunjucks `{{ var }}` / `{% if %}` syntax and render
 * through this one function.
 *
 * - `autoescape: false` — prompt text is not HTML; `<`, `>`, `&` must pass
 *   through verbatim.
 * - `throwOnUndefined: true` — a missing variable is a loud error, never a
 *   silently leaked `{{ placeholder }}` in the text sent to the model.
 */
const env = new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: true });

export function renderPrompt(template: string, vars: Record<string, unknown>): string {
  return env.renderString(template, vars);
}
