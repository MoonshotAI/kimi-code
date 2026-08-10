/**
 * Local `coder` agent profile system prompt — replaces the node-sdk
 * `DEFAULT_AGENT_PROFILES['coder']` renderer (G-1 consumption switch).
 *
 * The profile data is fixed: `coder` extends `agent`, whose `systemPromptPath`
 * points at `system.md`. Only the merged renderer the session engine consumes
 * is ported — the `roleAdditional` prompt var is extracted from the copied
 * `coder.yaml` resource (kept in sync with the retired node-sdk sources under
 * `packages/node-sdk/src/legacy/profile/default/`), and the template renderer
 * is the same `{{ var }}` / `{% if %}` subset the SDK used.
 */
import systemMd from './profile-assets/system.md?raw';
import coderYaml from './profile-assets/coder.yaml?raw';

/** Minimal kaos Environment shape the renderer reads. */
export interface CoderPromptOsEnv {
  readonly osKind: string;
  readonly shellName: string;
  readonly shellPath: string;
}

/** Runtime context supplied to the coder system prompt renderer. */
export interface CoderSystemPromptContext {
  readonly osEnv: CoderPromptOsEnv;
  readonly cwd: string;
  readonly cwdListing?: string;
  readonly agentsMd?: string;
  readonly additionalDirsInfo?: string;
  readonly now?: string | Date;
}

/**
 * Render the `coder` profile's system prompt with the merged `agent` template
 * and prompt vars — the same assembly the SDK's `ResolvedAgentProfile`
 * `systemPrompt` produced for the session engine.
 */
export function coderSystemPrompt(context: CoderSystemPromptContext): string {
  const vars: Record<string, string> = {
    KIMI_OS: context.osEnv.osKind,
    KIMI_SHELL: `${context.osEnv.shellName} (\`${context.osEnv.shellPath}\`)`,
    KIMI_NOW:
      context.now instanceof Date ? context.now.toISOString() : (context.now ?? new Date().toISOString()),
    KIMI_WORK_DIR: context.cwd,
    KIMI_WORK_DIR_LS: context.cwdListing ?? '',
    KIMI_AGENTS_MD: context.agentsMd ?? '',
    // The coder profile lists `Skill` in its tools, but the session engine
    // renders without a skill registry, so the skills section stays empty.
    KIMI_SKILLS: '',
    KIMI_ADDITIONAL_DIRS_INFO: context.additionalDirsInfo ?? '',
    ROLE_ADDITIONAL: ROLE_ADDITIONAL,
  };
  return renderPrompt(systemMd, vars);
}

/**
 * `coder.yaml` `promptVars.roleAdditional` — the subagent handoff identity
 * text. Extracted from the resource so template edits never require touching
 * this module.
 */
const ROLE_ADDITIONAL = extractRoleAdditional(coderYaml);

function extractRoleAdditional(yaml: string): string {
  const marker = 'roleAdditional: |';
  const markerIndex = yaml.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error('coder.yaml is missing the roleAdditional block');
  }
  const lines = yaml.slice(markerIndex + marker.length).split('\n');
  const body: string[] = [];
  for (const line of lines) {
    // The block ends at the next top-level key (no leading whitespace).
    if (line.length > 0 && !line.startsWith(' ')) break;
    body.push(line.replace(/^ {4}/, ''));
  }
  return body.join('\n').trim();
}

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
  let out = template.replaceAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, name: string) => {
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
    const varName = open[1];
    if (varName === undefined) break;
    const value = vars[varName];
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
