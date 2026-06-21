export type UIMode = 'shell' | 'print';
export type PromptOutputFormat = 'text' | 'stream-json';

export interface CLIOptions {
  session: string | undefined;
  sessionId?: string;
  continue: boolean;
  yolo: boolean;
  auto: boolean;
  plan: boolean;
  model: string | undefined;
  outputFormat: PromptOutputFormat | undefined;
  prompt: string | undefined;
  skillsDirs: string[];
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

export function validateOptions(opts: CLIOptions): ValidatedOptions {
  const prompt = opts.prompt;
  const promptMode = prompt !== undefined;
  if (promptMode && prompt.trim().length === 0) {
    throw new OptionConflictError('Prompt cannot be empty.');
  }
  if (opts.model !== undefined && opts.model.trim().length === 0) {
    throw new OptionConflictError('Model cannot be empty.');
  }
  if (opts.sessionId !== undefined && opts.sessionId.trim().length === 0) {
    throw new OptionConflictError('Session ID cannot be empty.');
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
  if (promptMode && opts.session === '') {
    throw new OptionConflictError('Cannot use --session without an id in prompt mode.');
  }
  if (opts.continue && opts.session !== undefined) {
    throw new OptionConflictError('Cannot combine --continue, --session.');
  }
  if (opts.sessionId !== undefined && opts.session !== undefined) {
    throw new OptionConflictError('Cannot combine --session-id with --session.');
  }
  if (opts.sessionId !== undefined && opts.continue) {
    throw new OptionConflictError('Cannot combine --continue with --session-id.');
  }
  if (opts.yolo && opts.auto) {
    throw new OptionConflictError('Cannot combine --yolo with --auto.');
  }
  return { options: opts, uiMode: promptMode ? 'print' : 'shell' };
}
