/**
 * MemoryTool — persistent memory search and management.
 *
 * Provides the model with a tool to search, read, write, list, and delete
 * memory entries that persist across sessions. Memory files are markdown
 * documents organized by scope (global, project, session).
 */

import { z } from 'zod';
import { isAbsolute, join } from 'pathe';

import { toInputJsonSchema } from '#/tool/input-schema';
import type { BuiltinTool, ToolExecution } from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IMemoryStore } from '#/app/memory/memoryStore';
import {
  detectType,
  extractTitle,
  memoryDir,
  projectIdFromCwd,
  scopeDir,
  type MemoryScope,
} from '#/app/memory/memoryPaths';
import DESCRIPTION from './memory.md?raw';
import { t } from '@moonshot-ai/kimi-i18n';

const MemoryActionSchema = z.enum(['search', 'read', 'write', 'list', 'delete']);

export const MemoryToolInputSchema = z
  .object({
    action: MemoryActionSchema.describe(
      'The memory operation to perform. `search` is the default.',
    ),
    query: z
      .string()
      .optional()
      .describe('Search query (for `search` action).'),
    path: z
      .string()
      .optional()
      .describe(
        'Memory file path (for `read`, `write`, `delete`). Can include or omit `.md` extension. For `read`/`delete`, this is the full relative path (e.g. `global/auth.md`). For `write`, this is the filename within the chosen scope.',
      ),
    scope: z
      .enum(['global', 'project', 'session'])
      .optional()
      .describe('Memory scope (for `write`, `list`). Defaults to `project`.'),
    content: z
      .string()
      .optional()
      .describe('Markdown content (for `write` action).'),
  })
  .strict();

export type MemoryToolInput = z.infer<typeof MemoryToolInputSchema>;

export class MemoryTool implements BuiltinTool<MemoryToolInput> {
  readonly name = 'Memory' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MemoryToolInputSchema);

  constructor(
    @IMemoryStore private readonly store: IMemoryStore,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {}

  resolveExecution(args: MemoryToolInput): ToolExecution {
    const action = args.action;

    return {
      description: t('toolsV2.memory.memoryAction', { action: action }),
      approvalRule: this.name,
      execute: async () => {
        switch (action) {
          case 'search':
            return this.handleSearch(args);
          case 'read':
            return this.handleRead(args);
          case 'write':
            return this.handleWrite(args);
          case 'list':
            return this.handleList(args);
          case 'delete':
            return this.handleDelete(args);
          default:
            return { output: t('toolsV2.memory.unknownAction', { action }), isError: true };
        }
      },
    };
  }

  private async handleSearch(args: MemoryToolInput) {
    if (!args.query) {
      return { output: t('toolsV2.memory.searchQueryRequired'), isError: true };
    }
    const results = await this.store.search(args.query, 10);
    if (results.length === 0) {
      return { output: t('toolsV2.memory.noEntriesFound', { query: args.query }) };
    }
    const plural = results.length === 1 ? 'y' : 'ies';
    const lines = [t('toolsV2.memory.foundEntries', { count: String(results.length), plural }) + '\n'];
    for (const r of results) {
      lines.push(`## ${r.title}`);
      lines.push(`  path: ${r.path}`);
      lines.push(`  scope: ${r.scope}${r.scopeId ? ` (${r.scopeId})` : ''}`);
      lines.push(`  type: ${r.type}`);
      lines.push(`  score: ${r.score.toFixed(3)}`);
      lines.push(`  snippet: ${r.snippet}`);
      lines.push('');
    }
    return { output: lines.join('\n') };
  }

  private async handleRead(args: MemoryToolInput) {
    if (!args.path) {
      return { output: t('toolsV2.memory.readPathRequired'), isError: true };
    }
    const path = normalizePath(args.path);
    const entry = await this.store.get(path);
    if (entry === undefined) {
      return { output: t('toolsV2.memory.notFound', { path }) };
    }
    const lines = [
      `# ${entry.title}`,
      `path: ${entry.path}`,
      `scope: ${entry.scope}${entry.scopeId ? ` (${entry.scopeId})` : ''}`,
      `type: ${entry.type}`,
      `updated: ${new Date(entry.updatedAt).toISOString()}`,
      '',
      entry.body,
    ];
    return { output: lines.join('\n') };
  }

  private async handleWrite(args: MemoryToolInput) {
    if (!args.path) {
      return { output: t('toolsV2.memory.writePathRequired'), isError: true };
    }
    if (!args.content) {
      return { output: t('toolsV2.memory.writeContentRequired'), isError: true };
    }

    const scope = args.scope ?? 'project';
    const scopeId = this.resolveScopeId(scope);
    const fileName = sanitizeFileName(args.path);
    if (fileName === undefined) {
      return {
        output: t('toolsV2.memory.invalidFilename', { path: args.path }),
        isError: true,
      };
    }
    const relPath = buildRelPath(scope, scopeId, fileName);

    const { stat, mkdir, writeFile } = await import('node:fs/promises');
    const { join: joinPath } = await import('pathe');

    const baseDir = memoryDir(this.bootstrap.homeDir);
    const fullDir = scopeDir(baseDir, scope, scopeId);
    const fullPath = joinPath(fullDir, fileName);

    await mkdir(fullDir, { recursive: true });
    await writeFile(fullPath, args.content, 'utf-8');
    const statInfo = await stat(fullPath);

    const entry = {
      path: relPath,
      scope,
      scopeId,
      type: detectType(args.content),
      title: extractTitle(args.content, fileName),
      body: args.content,
      fingerprint: `${statInfo.size}-${statInfo.mtimeMs}`,
      updatedAt: statInfo.mtimeMs,
    };
    await this.store.put(entry);

    return {
      output: t('toolsV2.memory.written', { path: relPath, title: entry.title, type: entry.type }),
    };
  }

  private async handleList(args: MemoryToolInput) {
    const allPaths = await this.store.list();
    const scope = args.scope;

    const filtered = scope
      ? allPaths.filter((p) => p.startsWith(`${scope === 'global' ? 'global' : scope === 'project' ? 'projects' : 'sessions'}/`))
      : allPaths;

    if (filtered.length === 0) {
      return { output: t('toolsV2.memory.noFilesFound') };
    }

    const lines = [t('toolsV2.memory.listHeader', { count: String(filtered.length) }) + '\n'];
    const sorted = [...filtered].sort();
    for (const p of sorted) {
      const entry = await this.store.get(p);
      if (entry) {
        lines.push(`  ${p} — ${entry.title} [${entry.type}]`);
      } else {
        lines.push(`  ${p}`);
      }
    }
    return { output: lines.join('\n') };
  }

  private async handleDelete(args: MemoryToolInput) {
    if (!args.path) {
      return { output: t('toolsV2.memory.deletePathRequired'), isError: true };
    }
    const path = normalizePath(args.path);
    const entry = await this.store.get(path);
    if (entry === undefined) {
      return { output: t('toolsV2.memory.notFound', { path }) };
    }

    // Delete from disk.
    const { unlink } = await import('node:fs/promises');
    const { join: joinPath } = await import('pathe');
    const homeDir = this.sessionContext.sessionDir
      .replace(/\/sessions\/.*$/, '');
    const fullPath = joinPath(memoryDir(homeDir), path);
    try {
      await unlink(fullPath);
    } catch {
      // File may already be gone — continue to delete from index.
    }

    await this.store.delete(path);
    return { output: t('toolsV2.memory.deleted', { path }) };
  }

  private resolveScopeId(scope: MemoryScope): string {
    if (scope === 'global') return '';
    if (scope === 'project') return projectIdFromCwd(this.sessionContext.cwd);
    return this.sessionContext.sessionId;
  }
}

function normalizePath(path: string): string {
  return path.endsWith('.md') ? path : `${path}.md`;
}

function normalizeFileName(name: string): string {
  return name.endsWith('.md') ? name : `${name}.md`;
}

function buildRelPath(scope: MemoryScope, scopeId: string, fileName: string): string {
  if (scope === 'global') return `global/${fileName}`;
  if (scope === 'project') return `projects/${scopeId}/${fileName}`;
  return `sessions/${scopeId}/${fileName}`;
}

registerTool(MemoryTool, {
  when: (accessor) => accessor.get(IAgentScopeContext).agentId === 'main',
});
