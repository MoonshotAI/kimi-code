import { z } from 'zod';

import { LOCAL_ENVIRONMENT_ID, type EnvironmentCapability, type EnvironmentStatus } from '#/environment/environment';
import type { EnvironmentGenerationSnapshot } from '#/environment/environmentRegistry';

export const ENVIRONMENT_ID_MAX_LENGTH = 64;
export const RESERVED_ENVIRONMENT_IDS = ['local', 'default'] as const;

const sshEnvironmentEntrySchema = z
  .object({
    type: z.literal('ssh'),
    host: z.string().min(1),
    remoteBin: z.string().min(1).optional(),
    defaultCwd: z.string().min(1).optional(),
  })
  .strict();

const dockerEnvironmentEntrySchema = z
  .object({
    type: z.literal('docker'),
    container: z.string().min(1),
    context: z.string().min(1).optional(),
    remoteBin: z.string().min(1).optional(),
    defaultCwd: z.string().min(1).optional(),
  })
  .strict();

const commandEnvironmentEntrySchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    remoteBin: z.string().min(1).optional(),
    defaultCwd: z.string().min(1).optional(),
  })
  .strict();

export const RemoteEnvironmentEntrySchema = z.union([
  sshEnvironmentEntrySchema,
  dockerEnvironmentEntrySchema,
  commandEnvironmentEntrySchema,
]);

export type RemoteEnvironmentEntry = z.infer<typeof RemoteEnvironmentEntrySchema>;

export function environmentIdProblem(id: string): string | undefined {
  if (id.length === 0) return 'must not be empty';
  if (id !== id.trim()) return 'must not have leading or trailing whitespace';
  if (id.length > ENVIRONMENT_ID_MAX_LENGTH) return `must be at most ${ENVIRONMENT_ID_MAX_LENGTH} characters`;
  if ((RESERVED_ENVIRONMENT_IDS as readonly string[]).includes(id)) {
    return `is reserved (${RESERVED_ENVIRONMENT_IDS.join(', ')})`;
  }
  return undefined;
}

export const EnvironmentsSectionSchema = z
  .object({
    default: z.string().optional(),
  })
  .catchall(RemoteEnvironmentEntrySchema)
  .superRefine((section, ctx) => {
    for (const id of Object.keys(section)) {
      if (id === 'default') continue;
      const problem = environmentIdProblem(id);
      if (problem !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [id],
          message: `environment id "${id}" ${problem}`,
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
        message: `environments.default references unconfigured environment "${defaultId}"`,
      });
      return;
    }
    if ((target as { defaultCwd?: unknown }).defaultCwd === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default'],
        message: `environments.default references environment "${defaultId}" which does not set defaultCwd`,
      });
    }
  });

export type EnvironmentsSection = z.infer<typeof EnvironmentsSectionSchema>;

export interface RemoteEnvironmentDeclaration {
  readonly id: string;
  readonly entry: RemoteEnvironmentEntry;
}

export interface EnvironmentDeclarationSet {
  readonly entries: readonly RemoteEnvironmentDeclaration[];
  readonly defaultId?: string;
}

export function sectionEntries(
  section: EnvironmentsSection | undefined,
): readonly RemoteEnvironmentDeclaration[] {
  if (section === undefined) return [];
  return Object.entries(section)
    .filter(([id]) => id !== 'default')
    .map(([id, entry]) => ({ id, entry: entry as RemoteEnvironmentEntry }));
}

export type EnvironmentEntryType = 'local' | 'ssh' | 'docker' | 'command';

export interface EnvironmentEntryInfo {
  readonly environmentId: string;
  readonly type: EnvironmentEntryType;
  readonly status: EnvironmentStatus;
  readonly generation: string;
  readonly capabilities: readonly EnvironmentCapability[];
  readonly defaultCwd?: string;
  readonly connectError?: string;
}

export function environmentEntryInfo(
  environment: EnvironmentGenerationSnapshot,
  entry: RemoteEnvironmentEntry | undefined,
): EnvironmentEntryInfo {
  return {
    environmentId: environment.environmentId,
    type:
      environment.environmentId === LOCAL_ENVIRONMENT_ID ? 'local'
        : entry === undefined || 'command' in entry ? 'command'
          : entry.type,
    status: environment.status,
    generation: environment.generation,
    capabilities: [...environment.capabilities],
    defaultCwd: entry?.defaultCwd,
    connectError: environment.connectError,
  };
}
