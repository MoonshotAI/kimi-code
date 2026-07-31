/**
 * `tools` domain — `IBashTool` contract.
 *
 * Public contract of Bash, the model's shell command runner: the command runs
 * as `cd <cwd> && <command>` inside the session's working directory, with a
 * manager-owned timeout deadline — a foreground command whose deadline fires
 * is moved to the background instead of being killed, and background tasks
 * report completion automatically in a later turn.
 *
 * Owns the `BashInput` / `BashOutput` zod schemas, the foreground/background
 * timeout constants the schema descriptions and validation share with the
 * implementation, and the Agent-scope service identifier. Bound at Agent
 * scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const DEFAULT_TIMEOUT_S = 60;
export const MAX_TIMEOUT_S = 5 * 60;
export const DEFAULT_BACKGROUND_TIMEOUT_S = 10 * 60;
export const MAX_BACKGROUND_TIMEOUT_S = 24 * 60 * 60;

function timeoutCapS(isBackground: boolean): number {
  return isBackground ? MAX_BACKGROUND_TIMEOUT_S : MAX_TIMEOUT_S;
}

function isValidTimeoutValue(timeout: number, isBackground: boolean): boolean {
  return timeout <= timeoutCapS(isBackground);
}

export const BashInputSchema = z
  .object({
    command: z.string().min(1, 'Command cannot be empty.').describe('The command to execute.'),
    cwd: z
      .string()
      .optional()
      .describe(
        "The working directory in which to run the command. When omitted, the command runs in the session's working directory.",
      ),
    timeout: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_TIMEOUT_S)
      .describe(
        `Optional timeout in seconds for the command to execute. Foreground default ${String(DEFAULT_TIMEOUT_S)}s, max ${String(MAX_TIMEOUT_S)}s. Background default ${String(DEFAULT_BACKGROUND_TIMEOUT_S)}s, max ${String(MAX_BACKGROUND_TIMEOUT_S)}s. Ignored for background commands when disable_timeout=true.`,
      )
      .optional(),
    description: z
      .string()
      .optional()
      .describe(
        'A short description for the background task. Required when run_in_background is true.',
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe('Whether to run the command as a background task.'),
    disable_timeout: z
      .boolean()
      .optional()
      .describe(
        'If true, do not apply a timeout to the command. Only applies when run_in_background is true.',
      ),
  })
  .superRefine((val, ctx) => {
    if (val.timeout === undefined) return;
    const isBackground = val.run_in_background === true;
    if (!isValidTimeoutValue(val.timeout, isBackground)) {
      const cap = isBackground ? MAX_BACKGROUND_TIMEOUT_S : MAX_TIMEOUT_S;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timeout'],
        message: `timeout must be ≤ ${String(cap)}s (${isBackground ? 'background' : 'foreground'})`,
      });
    }
  });

export const BashOutputSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

export type BashInput = z.infer<typeof BashInputSchema>;
export type BashOutput = z.infer<typeof BashOutputSchema>;

export interface IBashTool extends AgentTool<BashInput> { readonly _serviceBrand: undefined }
export const IBashTool = createDecorator<IBashTool>('bashTool');
