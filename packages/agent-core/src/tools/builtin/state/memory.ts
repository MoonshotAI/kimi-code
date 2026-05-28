/**
 * MemoryTool — durable cross-session memory.
 *
 * Single builtin tool with an `operation` discriminant. Backed by a
 * `FileMemoryStore` per session; the store is constructed lazily on first
 * use so `findProjectRoot` is resolved once.
 */

import { join } from 'pathe';

import type { Kaos } from '@moonshot-ai/kaos';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { findProjectRoot } from '../../../memory/find-project-root';
import { MEMORY_BODY_MAX_BYTES } from '../../../memory/format';
import { loadMemory } from '../../../memory/loader';
import { FileMemoryStore, MemoryStoreError } from '../../../memory/store';
import type {
  MemoryEntry,
  MemoryRecord,
  MemoryScope,
  MemoryType,
} from '../../../memory/types';
import type { TelemetryClient } from '../../../telemetry';
import { toInputJsonSchema } from '../../support/input-schema';
import type { WorkspaceConfig } from '../../support/workspace';
import DESCRIPTION from './memory.md';

// ── Schema ───────────────────────────────────────────────────────────

const MemoryTypeEnum = ['user', 'feedback', 'project', 'reference'] as const;
const MemoryScopeEnum = ['user', 'project'] as const;

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const MemoryRecordSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(
      SLUG_REGEX,
      'must be kebab-case (lowercase letters, digits, and hyphens; 1-64 chars; no leading/trailing hyphen)',
    )
    .describe('Canonical kebab-case slug; doubles as the filename without ".md".'),
  description: z
    .string()
    .min(1)
    .max(240)
    .describe('Single line, <= 240 chars. Shown in the rendered index.'),
  type: z
    .enum(MemoryTypeEnum)
    .describe('One of: user, feedback, project, reference.'),
});

const MemoryScopeSchema = z.enum(MemoryScopeEnum);
const MemoryTypeSchema = z.enum(MemoryTypeEnum);

export const MemoryInputSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('view') }),
  z.object({
    operation: z.literal('list'),
    scope: MemoryScopeSchema.optional(),
    type: MemoryTypeSchema.optional(),
  }),
  z.object({
    operation: z.literal('read'),
    scope: MemoryScopeSchema,
    name: z.string(),
  }),
  z.object({
    operation: z.literal('write'),
    scope: MemoryScopeSchema,
    record: MemoryRecordSchema,
    body: z.string().max(4096),
  }),
  z.object({
    operation: z.literal('update'),
    scope: MemoryScopeSchema,
    name: z.string(),
    record: MemoryRecordSchema.partial().optional(),
    body: z.string().max(4096).optional(),
  }),
  z.object({
    operation: z.literal('delete'),
    scope: MemoryScopeSchema,
    name: z.string(),
  }),
]);

export type MemoryInput = z.infer<typeof MemoryInputSchema>;

// ── Secret detection ─────────────────────────────────────────────────

interface SecretPattern {
  readonly category: string;
  readonly regex: RegExp;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  { category: 'anthropic-key', regex: /sk-[A-Za-z0-9-]{20,}/ },
  { category: 'github-token', regex: /gh[pousr]_[A-Za-z0-9]{36}/ },
  { category: 'aws-access-key', regex: /AKIA[0-9A-Z]{16}/ },
  { category: 'private-key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { category: 'slack-token', regex: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
];

function detectSecretCategories(body: string): readonly string[] {
  const matched: string[] = [];
  for (const { category, regex } of SECRET_PATTERNS) {
    if (regex.test(body)) matched.push(category);
  }
  return matched;
}

// ── Tool ─────────────────────────────────────────────────────────────

export class MemoryTool implements BuiltinTool<MemoryInput> {
  readonly name = 'memory' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MemoryInputSchema);

  private storePromise?: Promise<FileMemoryStore>;

  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
    private readonly telemetry?: TelemetryClient,
  ) {}

  resolveExecution(args: MemoryInput): ToolExecution {
    const parsed = MemoryInputSchema.safeParse(args);
    if (!parsed.success) {
      return {
        isError: true,
        output: formatSchemaError(parsed.error, args),
      };
    }
    const validated = parsed.data;
    return {
      description: describeOperation(validated),
      execute: () => this.execute(validated),
    };
  }

  private async execute(args: MemoryInput): Promise<ExecutableToolResult> {
    switch (args.operation) {
      case 'view':
        return this.view();
      case 'list':
        return this.list(args.scope, args.type);
      case 'read':
        return this.read(args.scope, args.name);
      case 'write':
        return this.write(args.scope, args.record, args.body);
      case 'update':
        return this.update(args.scope, args.name, args.record, args.body);
      case 'delete':
        return this.delete(args.scope, args.name);
      default: {
        const _exhaustive: never = args;
        return _exhaustive;
      }
    }
  }

  private async store(): Promise<FileMemoryStore> {
    this.storePromise ??= this.buildStore();
    return this.storePromise;
  }

  private async buildStore(): Promise<FileMemoryStore> {
    const userRoot = join(this.kaos.gethome(), '.kimi-code', 'memory');
    const projectRoot = join(
      await findProjectRoot(this.kaos, this.workspace.workspaceDir),
      '.kimi-code',
      'memory',
    );
    return new FileMemoryStore(this.kaos, userRoot, projectRoot);
  }

  // ── Operation handlers ────────────────────────────────────────────

  private async view(): Promise<ExecutableToolResult> {
    const rendered = await loadMemory(this.kaos, this.workspace.workspaceDir, this.telemetry);
    return { isError: false, output: rendered === '' ? 'No memory facts stored.' : rendered };
  }

  private async list(
    scope: MemoryScope | undefined,
    type: MemoryType | undefined,
  ): Promise<ExecutableToolResult> {
    const store = await this.store();
    const scopes: readonly MemoryScope[] = scope === undefined ? ['project', 'user'] : [scope];
    const sections: string[] = [];
    let total = 0;
    for (const s of scopes) {
      const entries = await store.list(s);
      const filtered =
        type === undefined ? entries : entries.filter((e) => e.record.type === type);
      if (filtered.length === 0) continue;
      total += filtered.length;
      sections.push(`## ${s === 'project' ? 'Project' : 'User'}`);
      for (const entry of filtered) {
        sections.push(`- ${entry.record.name} (${entry.record.type}) — ${entry.record.description}`);
      }
      sections.push('');
    }
    if (total === 0) {
      return { isError: false, output: 'No memory facts match the requested filters.' };
    }
    return { isError: false, output: sections.join('\n').trimEnd() };
  }

  private async read(scope: MemoryScope, slug: string): Promise<ExecutableToolResult> {
    const store = await this.store();
    let entry: MemoryEntry | undefined;
    try {
      entry = await store.read(scope, slug);
    } catch (error) {
      return mapStoreError(error, scope, slug);
    }
    if (entry === undefined) {
      return {
        isError: true,
        output:
          `NOT_FOUND: no fact "${slug}" in ${scope} scope. ` +
          `Call operation "list" to see available slugs.`,
      };
    }
    const text =
      `---\nname: ${entry.record.name}\ndescription: ${entry.record.description}\ntype: ${entry.record.type}\n---\n\n${entry.body}\n`;
    return { isError: false, output: text };
  }

  private async write(
    scope: MemoryScope,
    record: MemoryRecord,
    body: string,
  ): Promise<ExecutableToolResult> {
    const store = await this.store();
    let entry: MemoryEntry;
    try {
      entry = await store.write(scope, record, body);
    } catch (error) {
      return mapStoreError(error, scope, record.name);
    }
    this.emit('memory_write', { scope, slug: entry.record.name });
    const lines = [
      `Wrote memory "${entry.record.name}" to ${scope} scope.`,
      `- ${entry.record.name} (${entry.record.type}) — ${entry.record.description}`,
    ];
    const categories = detectSecretCategories(body);
    if (categories.length > 0) {
      lines.push(
        `Warning: body matched secret pattern category ${categories.join(', ')}. ` +
          `Memory is plaintext on disk — remove the secret or rotate the credential.`,
      );
    }
    return { isError: false, output: lines.join('\n') };
  }

  private async update(
    scope: MemoryScope,
    slug: string,
    recordPatch: Partial<MemoryRecord> | undefined,
    body: string | undefined,
  ): Promise<ExecutableToolResult> {
    const store = await this.store();
    let entry: MemoryEntry;
    try {
      entry = await store.update(scope, slug, { record: recordPatch, body });
    } catch (error) {
      return mapStoreError(error, scope, slug);
    }
    this.emit('memory_update', { scope, slug: entry.record.name });
    const lines = [
      `Updated memory "${entry.record.name}" in ${scope} scope.`,
      `- ${entry.record.name} (${entry.record.type}) — ${entry.record.description}`,
    ];
    if (body !== undefined) {
      const categories = detectSecretCategories(body);
      if (categories.length > 0) {
        lines.push(
          `Warning: body matched secret pattern category ${categories.join(', ')}. ` +
            `Memory is plaintext on disk — remove the secret or rotate the credential.`,
        );
      }
    }
    return { isError: false, output: lines.join('\n') };
  }

  private async delete(scope: MemoryScope, slug: string): Promise<ExecutableToolResult> {
    const store = await this.store();
    let removed: boolean;
    try {
      removed = await store.delete(scope, slug);
    } catch (error) {
      return mapStoreError(error, scope, slug);
    }
    if (!removed) {
      return {
        isError: true,
        output: `NOT_FOUND: no fact "${slug}" in ${scope} scope. Nothing was deleted.`,
      };
    }
    this.emit('memory_delete', { scope, slug });
    return { isError: false, output: `Deleted memory "${slug}" from ${scope} scope.` };
  }

  // Fire-and-forget telemetry: a thrown sink error must not fail the operation.
  // Payloads carry only scope and slug — never body content.
  private emit(event: string, properties: { readonly scope: MemoryScope; readonly slug: string }): void {
    if (this.telemetry === undefined) return;
    try {
      this.telemetry.track(event, properties);
    } catch {
      // swallow
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function describeOperation(args: MemoryInput): string {
  switch (args.operation) {
    case 'view':
      return 'Viewing memory index';
    case 'list':
      return 'Listing memory facts';
    case 'read':
      return `Reading memory "${args.name}"`;
    case 'write':
      return `Writing memory "${args.record.name}"`;
    case 'update':
      return `Updating memory "${args.name}"`;
    case 'delete':
      return `Deleting memory "${args.name}"`;
    default: {
      const _exhaustive: never = args;
      return _exhaustive;
    }
  }
}

function formatSchemaError(error: z.ZodError, args: unknown): string {
  const bodyTooLarge = error.issues.some(
    (issue) => issue.path.join('.') === 'body' && issue.code === 'too_big',
  );
  if (bodyTooLarge) {
    return `BODY_TOO_LARGE: body exceeds the 4 KB (${String(MEMORY_BODY_MAX_BYTES)}-byte) limit.`;
  }
  const invalidSlug = error.issues.some(
    (issue) =>
      issue.path.join('.') === 'record.name' &&
      (issue.code === 'invalid_format' ||
        issue.code === 'too_small' ||
        issue.code === 'too_big'),
  );
  if (invalidSlug) {
    return (
      'INVALID_SLUG: record.name must be kebab-case (lowercase letters, digits, and hyphens; ' +
      '1-64 chars; no leading/trailing hyphen).'
    );
  }
  const issues = error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
  const lines = ['INVALID_INPUT: ' + issues.join('; ')];
  const looksLikeWrite =
    typeof args === 'object' && args !== null && (args as { operation?: unknown }).operation === 'write';
  if (looksLikeWrite) {
    lines.push(
      'record requires fields: name (kebab-case slug), description (<=240 chars), ' +
        `type (one of: ${MemoryTypeEnum.join(', ')}).`,
    );
  }
  return lines.join('\n');
}

function mapStoreError(
  error: unknown,
  scope: MemoryScope,
  slug: string,
): ExecutableToolResult {
  if (error instanceof MemoryStoreError) {
    return { isError: true, output: `${error.reason}: ${error.message}` };
  }
  if (error instanceof Error) {
    return { isError: true, output: `IO_ERROR: ${error.message} (${scope}/${slug})` };
  }
  return { isError: true, output: `IO_ERROR: ${String(error)} (${scope}/${slug})` };
}
