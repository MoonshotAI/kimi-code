import { z } from 'zod';

import { resolveProgramPath } from './programPath';

export const RUNTIME_ID_MAX_LENGTH = 64;
export const RESERVED_RUNTIME_IDS = ['local', 'default'] as const;
export const DEFAULT_REMOTE_BIN = '~/.kimi-code/bin/kimi';

const sshRuntimeEntrySchema = z
  .object({
    type: z.literal('ssh'),
    host: z.string().min(1),
    remoteBin: z.string().min(1).optional(),
    defaultCwd: z.string().min(1).optional(),
  })
  .strict();

const dockerRuntimeEntrySchema = z
  .object({
    type: z.literal('docker'),
    container: z.string().min(1),
    context: z.string().min(1).optional(),
    remoteBin: z.string().min(1).optional(),
    defaultCwd: z.string().min(1).optional(),
  })
  .strict();

const commandRuntimeEntrySchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    defaultCwd: z.string().min(1).optional(),
  })
  .strict();

export const RemoteRuntimeEntrySchema = z.union([
  sshRuntimeEntrySchema,
  dockerRuntimeEntrySchema,
  commandRuntimeEntrySchema,
]);

export type RemoteRuntimeEntry = z.infer<typeof RemoteRuntimeEntrySchema>;
export type SshRuntimeEntry = z.infer<typeof sshRuntimeEntrySchema>;
export type DockerRuntimeEntry = z.infer<typeof dockerRuntimeEntrySchema>;
export type CommandRuntimeEntry = z.infer<typeof commandRuntimeEntrySchema>;

export function runtimeIdProblem(id: string): string | undefined {
  if (id.length === 0) return 'must not be empty';
  if (id !== id.trim()) return 'must not have leading or trailing whitespace';
  if (id.length > RUNTIME_ID_MAX_LENGTH) return `must be at most ${RUNTIME_ID_MAX_LENGTH} characters`;
  if ((RESERVED_RUNTIME_IDS as readonly string[]).includes(id)) {
    return `is reserved (${RESERVED_RUNTIME_IDS.join(', ')})`;
  }
  return undefined;
}

export const RuntimesSectionSchema = z
  .object({
    default: z.string().optional(),
  })
  .catchall(RemoteRuntimeEntrySchema)
  .superRefine((section, ctx) => {
    for (const id of Object.keys(section)) {
      if (id === 'default') continue;
      const problem = runtimeIdProblem(id);
      if (problem !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [id],
          message: `runtime id "${id}" ${problem}`,
        });
      }
    }
    const defaultId = section.default;
    if (defaultId === undefined) return;
    const target = (section as Record<string, unknown>)[defaultId];
    if (target === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default'],
        message: `runtimes.default references unconfigured runtime "${defaultId}"`,
      });
      return;
    }
    if ((target as { defaultCwd?: unknown }).defaultCwd === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default'],
        message: `runtimes.default references runtime "${defaultId}" which does not set defaultCwd`,
      });
    }
  });

export type RuntimesSection = z.infer<typeof RuntimesSectionSchema>;

export type RuntimeDeclarationSource = 'user' | 'project';

export interface RemoteRuntimeDeclaration {
  readonly id: string;
  readonly entry: RemoteRuntimeEntry;
  readonly source: RuntimeDeclarationSource;
}

export interface RuntimeDeclarationDefault {
  readonly runtimeId: string;
  readonly cwd: string;
}

export interface RuntimeDeclarationSet {
  readonly entries: readonly RemoteRuntimeDeclaration[];
  readonly default?: RuntimeDeclarationDefault;
  readonly projectError?: unknown;
}

export function sectionEntries(
  section: RuntimesSection | undefined,
  source: RuntimeDeclarationSource,
): readonly RemoteRuntimeDeclaration[] {
  if (section === undefined) return [];
  return Object.entries(section)
    .filter(([id]) => id !== 'default')
    .map(([id, entry]) => ({ id, entry: entry as RemoteRuntimeEntry, source }));
}

export function sectionDefault(section: RuntimesSection | undefined): RuntimeDeclarationDefault | undefined {
  const defaultId = section?.default;
  if (defaultId === undefined) return undefined;
  const entry = (section as Record<string, unknown>)[defaultId] as RemoteRuntimeEntry | undefined;
  if (entry?.defaultCwd === undefined) return undefined;
  return { runtimeId: defaultId, cwd: entry.defaultCwd };
}

export function mergeRuntimeDeclarations(
  user: readonly RemoteRuntimeDeclaration[],
  project: readonly RemoteRuntimeDeclaration[],
): readonly RemoteRuntimeDeclaration[] {
  const merged = new Map<string, RemoteRuntimeDeclaration>();
  for (const declaration of user) merged.set(declaration.id, declaration);
  for (const declaration of project) merged.set(declaration.id, declaration);
  return [...merged.values()];
}

export function describeRuntimeEntry(
  entry: RemoteRuntimeEntry,
  options?: { readonly cwd?: string },
): string {
  if ('command' in entry) {
    return [resolveProgramPath(entry.command, { cwd: options?.cwd }), ...(entry.args ?? [])].join(' ');
  }
  const remoteBin = entry.remoteBin ?? DEFAULT_REMOTE_BIN;
  switch (entry.type) {
    case 'ssh':
      return `ssh ${entry.host} ${remoteBin} exec-server --listen stdio`;
    case 'docker':
      return `docker ${entry.context === undefined ? '' : `--context ${entry.context} `}exec ${entry.container} ${remoteBin} exec-server --listen stdio`;
  }
}
