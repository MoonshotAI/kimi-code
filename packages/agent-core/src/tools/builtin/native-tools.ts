/**
 * Native tool adapters — wraps Rust native tools to implement the
 * ExecutableTool interface used by the agent loop.
 *
 * Feature flag: set `KIMI_CODE_EXPERIMENTAL_NATIVE_TOOLS=0` to disable native tools.
 * When disabled or when the native module fails to load,
 * the TypeScript originals are used as fallback.
 */

import type { Kaos } from '@moonshot-ai/kaos';
import { z } from 'zod';

import type { BackgroundManager } from '../../agent/background';
import { flags } from '../../flags';
import type { BuiltinTool } from '../../agent/tool';
import type { ToolExecution } from '../../loop/types';
import { ToolAccesses } from '../../loop/tool-access';
import { isWithinDirectory, resolvePathAccessPath } from '../../tools/policies/path-access';
import type { WorkspaceConfig } from '../../tools/support/workspace';
import { toInputJsonSchema } from '../../tools/support/input-schema';
import {
  literalRulePattern,
  matchesGlobRuleSubject,
  matchesPathRuleSubject,
} from '../../tools/support/rule-match';
import { BashTool, type BashInput } from './shell/bash';

// Lazy-load the native module to avoid hard dependency.
let nativeModule: Record<string, unknown> | undefined;

function getNativeModule(): Record<string, unknown> | undefined {
  if (nativeModule !== undefined) return nativeModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nativeModule = require('@moonshot-ai/kimi-native-tools');
    return nativeModule;
  } catch {
    return undefined;
  }
}

export function isNativeToolsEnabled(): boolean {
  return flags.enabled('native_tools');
}

export function tryLoadNative(): Record<string, unknown> | undefined {
  if (!isNativeToolsEnabled()) return undefined;
  return getNativeModule();
}

function callNative<T>(fnName: string, ...args: unknown[]): T | undefined {
  const mod = getNativeModule();
  if (!mod) return undefined;
  const fn = mod[fnName];
  if (typeof fn !== 'function') return undefined;
  return fn(...args) as T;
}

function joinSearchPath(base: string, relativePath: string, pathClass: 'posix' | 'win32'): string {
  if (relativePath === '') return base;
  const separator = pathClass === 'win32' ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${separator}${relativePath}`;
}

// ============================================================================
// ReadTool adapter
// ============================================================================

const NativeReadInputSchema = z.object({
  path: z.string().describe('Path to a text file.'),
  line_offset: z.number().int().optional().describe('Line to start from (1-indexed). Negative = tail.'),
  n_lines: z.number().int().positive().optional().describe('Number of lines to read. Capped at 1000.'),
});

export class NativeReadTool implements BuiltinTool {
  readonly name = 'Read' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown>;

  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
    description: string,
  ) {
    this.description = description;
    this.parameters = toInputJsonSchema(NativeReadInputSchema);
  }

  resolveExecution(input: { path: string; line_offset?: number; n_lines?: number }): ToolExecution {
    const path = resolvePathAccessPath(input.path, {
      kaos: this.kaos,
      workspace: this.workspace,
      operation: 'read',
    });

    return {
      accesses: ToolAccesses.readFile(path),
      description: `Reading ${input.path}`,
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspace.workspaceDir,
          pathClass: this.kaos.pathClass(),
          homeDir: this.kaos.gethome(),
        }),
      execute: async () => {
        const result = callNative<{ content: string; lineCount: number; error?: string }>(
          'nativeRead',
          path,
          { lineOffset: input.line_offset, nLines: input.n_lines },
        );
        if (!result) {
          return { isError: true, output: 'Native tools module not available.' };
        }
        if (result.error) {
          return { isError: true, output: result.error };
        }
        return { output: result.content };
      },
    };
  }
}

// ============================================================================
// WriteTool adapter
// ============================================================================

const NativeWriteInputSchema = z.object({
  path: z.string().describe('Path to the file to create or overwrite.'),
  content: z.string().describe('Raw content to write.'),
  mode: z.enum(['overwrite', 'append']).optional().describe('Write mode.'),
});

export class NativeWriteTool implements BuiltinTool {
  readonly name = 'Write' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown>;

  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
    description: string,
  ) {
    this.description = description;
    this.parameters = toInputJsonSchema(NativeWriteInputSchema);
  }

  resolveExecution(input: { path: string; content: string; mode?: string }): ToolExecution {
    const path = resolvePathAccessPath(input.path, {
      kaos: this.kaos,
      workspace: this.workspace,
      operation: 'write',
    });

    return {
      accesses: ToolAccesses.writeFile(path),
      description: `Writing ${input.path}`,
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspace.workspaceDir,
          pathClass: this.kaos.pathClass(),
          homeDir: this.kaos.gethome(),
        }),
      execute: async () => {
        const result = callNative<{ bytesWritten: number; error?: string }>(
          'nativeWrite',
          path,
          input.content,
          { mode: input.mode },
        );
        if (!result) {
          return { isError: true, output: 'Native tools module not available.' };
        }
        if (result.error) {
          return { isError: true, output: result.error };
        }
        const verb = input.mode === 'append' ? 'Appended' : 'Wrote';
        return { output: `${verb} ${result.bytesWritten} bytes to ${input.path}` };
      },
    };
  }
}

// ============================================================================
// EditTool adapter
// ============================================================================

const NativeEditInputSchema = z.object({
  path: z.string().describe('Path to the file to edit.'),
  old_string: z.string().min(1).describe('Exact content to replace.'),
  new_string: z.string().describe('Replacement text.'),
  replace_all: z.boolean().optional().describe('Replace all occurrences.'),
});

export class NativeEditTool implements BuiltinTool {
  readonly name = 'Edit' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown>;

  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
    description: string,
  ) {
    this.description = description;
    this.parameters = toInputJsonSchema(NativeEditInputSchema);
  }

  resolveExecution(input: { path: string; old_string: string; new_string: string; replace_all?: boolean }): ToolExecution {
    const path = resolvePathAccessPath(input.path, {
      kaos: this.kaos,
      workspace: this.workspace,
      operation: 'write',
    });

    return {
      accesses: ToolAccesses.writeFile(path),
      description: `Editing ${input.path}`,
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspace.workspaceDir,
          pathClass: this.kaos.pathClass(),
          homeDir: this.kaos.gethome(),
        }),
      execute: async () => {
        const result = callNative<{ success: boolean; error?: string; replacements: number }>(
          'nativeEdit',
          path,
          input.old_string,
          input.new_string,
          { replaceAll: input.replace_all },
        );
        if (!result) {
          return { isError: true, output: 'Native tools module not available.' };
        }
        if (!result.success) {
          return { isError: true, output: result.error ?? 'Edit failed.' };
        }
        const word = result.replacements === 1 ? 'occurrence' : 'occurrences';
        return { output: `Replaced ${result.replacements} ${word} in ${input.path}` };
      },
    };
  }
}

// ============================================================================
// GrepTool adapter
// ============================================================================

const NativeGrepInputSchema = z.object({
  pattern: z.string().describe('Regular expression to search for.'),
  path: z.string().optional().describe('File or directory to search.'),
  glob: z.string().optional().describe('Glob filter.'),
  type: z
    .string()
    .optional()
    .describe(
      'Ripgrep-style file type filter (`ts`, `py`, `rust`, ...). Resolved against a built-in extension table.',
    ),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count_matches'])
    .optional()
    .describe('Output mode.'),
  '-i': z.boolean().optional().describe('Case-insensitive search.'),
  '-n': z.boolean().optional().describe('Show line numbers.'),
  '-A': z.number().int().nonnegative().optional().describe('Lines after match.'),
  '-B': z.number().int().nonnegative().optional().describe('Lines before match.'),
  '-C': z.number().int().nonnegative().optional().describe('Context lines.'),
  head_limit: z.number().int().nonnegative().optional().describe('Max output lines.'),
  offset: z.number().int().nonnegative().optional().describe('Skip first N entries.'),
  multiline: z.boolean().optional().describe('Multiline matching.'),
  include_ignored: z
    .boolean()
    .optional()
    .describe(
      'Also search files excluded by .gitignore. Sensitive files (.env, id_rsa, .aws/credentials, ...) stay filtered.',
    ),
});

export class NativeGrepTool implements BuiltinTool {
  readonly name = 'Grep' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown>;

  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
    description: string,
  ) {
    this.description = description;
    this.parameters = toInputJsonSchema(NativeGrepInputSchema);
  }

  resolveExecution(input: {
    pattern: string;
    path?: string;
    glob?: string;
    type?: string;
    output_mode?: string;
    '-i'?: boolean;
    '-n'?: boolean;
    '-A'?: number;
    '-B'?: number;
    '-C'?: number;
    head_limit?: number;
    offset?: number;
    multiline?: boolean;
    include_ignored?: boolean;
  }): ToolExecution {
    let searchPath: string | undefined;
    if (input.path !== undefined) {
      searchPath = resolvePathAccessPath(input.path, {
        kaos: this.kaos,
        workspace: this.workspace,
        operation: 'search',
        policy: { guardMode: 'absolute-outside-allowed', checkSensitive: false },
      });
    }
    const accesses = ToolAccesses.searchTree(searchPath ?? this.workspace.workspaceDir);

    return {
      accesses,
      description: `Searching ${searchPath ?? 'workspace'}`,
      approvalRule: literalRulePattern(this.name, input.pattern),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, input.pattern),
      execute: async () => {
        const result = callNative<{
          content: string;
          error?: string;
          matchCount: number;
          fileCount: number;
          filteredSensitive: string[];
          timedOut: boolean;
        }>('nativeGrep', input.pattern, {
          path: searchPath,
          glob: input.glob,
          fileType: input.type,
          outputMode: input.output_mode,
          caseInsensitive: input['-i'],
          lineNumbers: input['-n'],
          afterContext: input['-A'],
          beforeContext: input['-B'],
          context: input['-C'],
          headLimit: input.head_limit,
          offset: input.offset,
          multiline: input.multiline,
          includeIgnored: input.include_ignored,
        });
        if (!result) {
          return { isError: true, output: 'Native tools module not available.' };
        }
        if (result.error) {
          return { isError: true, output: result.error };
        }
        const notices: string[] = [];
        if (result.filteredSensitive.length > 0) {
          notices.push(
            `Filtered ${result.filteredSensitive.length} sensitive file(s): ${result.filteredSensitive.join(', ')}`,
          );
        }
        if (result.timedOut) {
          notices.push(`Grep timed out; partial results returned.`);
        }
        const output =
          notices.length > 0
            ? result.content === ''
              ? notices.join('\n')
              : `${result.content}\n${notices.join('\n')}`
            : result.content;
        const message =
          input.output_mode === 'count_matches'
            ? `Found ${result.matchCount} ${result.matchCount === 1 ? 'occurrence' : 'occurrences'} across ${result.fileCount} ${result.fileCount === 1 ? 'file' : 'files'}.`
            : undefined;
        return { output, message };
      },
    };
  }
}

// ============================================================================
// GlobTool adapter
// ============================================================================

const NativeGlobInputSchema = z.object({
  pattern: z.string().describe('Glob pattern.'),
  path: z.string().optional().describe('Directory to search.'),
  include_dirs: z.boolean().optional().describe('Include directories.'),
});

export class NativeGlobTool implements BuiltinTool {
  readonly name = 'Glob' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown>;

  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
    description: string,
  ) {
    this.description = description;
    this.parameters = toInputJsonSchema(NativeGlobInputSchema);
  }

  resolveExecution(input: { pattern: string; path?: string; include_dirs?: boolean }): ToolExecution {
    const searchPath = input.path
      ? resolvePathAccessPath(input.path, {
          kaos: this.kaos,
          workspace: this.workspace,
          operation: 'search',
          policy: { guardMode: 'absolute-outside-allowed', checkSensitive: false },
        })
      : this.workspace.workspaceDir;
    const accesses = ToolAccesses.searchTree(searchPath);

    return {
      accesses,
      description: `Globbing ${searchPath}`,
      approvalRule: literalRulePattern(this.name, input.pattern),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, input.pattern),
      execute: async () => {
        const result = callNative<{ files: string[]; error?: string; truncated: boolean }>(
          'nativeGlob',
          input.pattern,
          { path: searchPath, includeDirs: input.include_dirs },
        );
        if (!result) {
          return { isError: true, output: 'Native tools module not available.' };
        }
        if (result.error) {
          return { isError: true, output: result.error };
        }
        const pathClass = this.kaos.pathClass();
        const shouldRelativize = isWithinDirectory(searchPath, this.workspace.workspaceDir, pathClass);
        const files = shouldRelativize
          ? result.files
          : result.files.map((file) => joinSearchPath(searchPath, file, pathClass));
        const content = files.join('\n');
        const truncationNote = result.truncated
          ? `\n\nResults truncated to ${result.files.length} matches.`
          : '';
        return { output: content + truncationNote };
      },
    };
  }
}

export class NativeBashTool extends BashTool {
  private readonly nativeCwd: string;

  constructor(
    kaos: Kaos,
    cwd: string,
    backgroundManager: BackgroundManager,
    options?: {
      allowBackground?: boolean | undefined;
    },
  ) {
    super(kaos, cwd, backgroundManager, options);
    this.nativeCwd = cwd;
  }

  override resolveExecution(args: BashInput): ToolExecution {
    const parentExecution = super.resolveExecution(args);
    if (args.run_in_background === true || parentExecution.isError === true) {
      return parentExecution;
    }

    const cwd = args.cwd ?? this.nativeCwd;
    return {
      ...parentExecution,
      execute: async () => {
        const result = callNative<{
          exitCode: number;
          stdout: string;
          stderr: string;
          timedOut: boolean;
          error?: string;
        }>('nativeBash', args.command, {
          cwd,
          timeout: args.timeout,
        });
        if (!result) {
          return { isError: true, output: 'Native tools module not available.' };
        }
        if (result.error) {
          return { isError: true, output: result.error };
        }

        let output = '';
        if (result.stdout) output += result.stdout;
        if (result.stderr) {
          if (output) output += '\n';
          output += `[stderr]\n${result.stderr}`;
        }
        if (result.timedOut) {
          output += `\n\nCommand timed out after ${args.timeout ?? 60}s.`;
        }
        if (result.exitCode !== 0) {
          output += `\n\nExit code: ${result.exitCode}`;
        }

        return {
          output: output || '(no output)',
          isError: result.exitCode !== 0 ? true : undefined,
        };
      },
    };
  }
}

// ============================================================================
// ListDirectory adapter (standalone function, not a BuiltinTool)
// ============================================================================

export interface NativeListDirectoryOptions {
  collapseHiddenDirs?: boolean;
}

/**
 * Try the native Rust list_directory implementation first.
 * Falls back to the TS implementation if the native module is unavailable.
 *
 * @param kaos - Kaos instance (used by TS fallback only).
 * @param workDir - Directory to list. Defaults to kaos.getcwd().
 * @param options - Options (collapseHiddenDirs).
 * @returns The directory tree listing string.
 */
export async function nativeListDirectory(
  kaos: Kaos,
  workDir?: string,
  options?: NativeListDirectoryOptions,
): Promise<string | undefined> {
  try {
    const mod = getNativeModule();
    if (!mod) return undefined;
    const fn = mod['nativeListDirectory'] as
      | ((opts: { path?: string; collapseHiddenDirs?: boolean }) => { output: string; error?: string })
      | undefined;
    if (typeof fn !== 'function') return undefined;

    const effectiveDir = workDir ?? kaos.getcwd();
    const result = fn({ path: effectiveDir, collapseHiddenDirs: options?.collapseHiddenDirs });
    if (result.error) return undefined; // fall back to TS on error
    return result.output;
  } catch {
    return undefined; // native module unavailable or binary mismatch — fall back to TS
  }
}
