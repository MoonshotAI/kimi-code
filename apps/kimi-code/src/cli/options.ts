import { isKimiV2Enabled } from './experimental-v2';

export type UIMode = 'shell' | 'print';
export type PromptOutputFormat = 'text' | 'stream-json';

/** Environment variable that sets the default `-p` output format (flag wins). */
export const OUTPUT_FORMAT_ENV = 'KIMI_MODEL_OUTPUT_FORMAT';

const OUTPUT_FORMATS = ['text', 'stream-json'] as const;

function isOutputFormat(value: string): value is PromptOutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value);
}

/**
 * Resolve the effective `-p` output format.
 *
 * Precedence: explicit `--output-format` flag → `KIMI_MODEL_OUTPUT_FORMAT` env
 * (prompt mode only) → `text`. The env var is ignored outside prompt mode so an
 * ambient value never affects interactive `kimi`. An invalid env value fails
 * fast via `OptionConflictError`.
 */
export function resolveOutputFormat(
  opts: Pick<CLIOptions, 'prompt' | 'outputFormat'>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): PromptOutputFormat {
  if (opts.outputFormat !== undefined) return opts.outputFormat;
  if (opts.prompt === undefined) return 'text';
  const raw = (env[OUTPUT_FORMAT_ENV] ?? '').trim();
  if (raw.length === 0) return 'text';
  if (!isOutputFormat(raw)) {
    throw new OptionConflictError(
      `Invalid ${OUTPUT_FORMAT_ENV} value "${raw}". Expected one of: text, stream-json.`,
    );
  }
  return raw;
}

export interface CLIOptions {
  session: string | undefined;
  continue: boolean;
  yolo: boolean;
  auto: boolean;
  plan: boolean;
  model: string | undefined;
  outputFormat: PromptOutputFormat | undefined;
  prompt: string | undefined;
  skillsDirs: string[];
  agent: string | undefined;
  agentFiles: string[];
  addDirs?: string[];
}

export interface ValidatedOptions {
  options: CLIOptions;
  uiMode: UIMode;
}

export class OptionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptionConflictError';
  }
}

export function validateOptions(
  opts: CLIOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ValidatedOptions {
  const prompt = opts.prompt;
  const promptMode = prompt !== undefined;
  if (promptMode && prompt.trim().length === 0) {
    throw new OptionConflictError('Prompt cannot be empty.');
  }
  if (opts.model !== undefined && opts.model.trim().length === 0) {
    throw new OptionConflictError('Model cannot be empty.');
  }
  if (!promptMode && opts.outputFormat !== undefined) {
    throw new OptionConflictError('Output format is only supported in prompt mode.');
  }
  if (promptMode && opts.yolo) {
    throw new OptionConflictError('Cannot combine --prompt with --yolo.');
  }
  if (promptMode && opts.auto) {
    throw new OptionConflictError('Cannot combine --prompt with --auto.');
  }
  if (promptMode && opts.plan) {
    throw new OptionConflictError('Cannot combine --prompt with --plan.');
  }
  if (opts.agent !== undefined && opts.agent.trim().length === 0) {
    throw new OptionConflictError('Agent cannot be empty.');
  }
  if (opts.agentFiles.length > 1) {
    throw new OptionConflictError('--agent-file may only be specified once.');
  }
  if (opts.agentFiles.some((file) => file.trim().length === 0)) {
    throw new OptionConflictError('Agent file path cannot be empty.');
  }
  if (opts.agent !== undefined && opts.agentFiles.length > 0) {
    throw new OptionConflictError('Cannot combine --agent with --agent-file.');
  }
  if (
    (opts.agent !== undefined || opts.agentFiles.length > 0) &&
    (!promptMode || !isKimiV2Enabled(env))
  ) {
    throw new OptionConflictError(
      '--agent/--agent-file are only available with the v2 engine (kimi -p with KIMI_CODE_EXPERIMENTAL_FLAG=1).',
    );
  }
  if (promptMode && opts.session === '') {
    throw new OptionConflictError('Cannot use --session without an id in prompt mode.');
  }
  if (opts.continue && opts.session !== undefined) {
    throw new OptionConflictError('Cannot combine --continue, --session.');
  }
  if (opts.yolo && opts.auto) {
    throw new OptionConflictError('Cannot combine --yolo with --auto.');
  }
  // Validate `KIMI_MODEL_OUTPUT_FORMAT` eagerly in prompt mode so a typo fails
  // fast through the friendly `error:` path instead of mid-run.
  if (promptMode) resolveOutputFormat(opts, env);
  return { options: opts, uiMode: promptMode ? 'print' : 'shell' };
}
