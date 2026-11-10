import { createHash, randomUUID } from 'node:crypto';

import { dump } from 'js-yaml';
import { dirname, join } from 'pathe';

import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { parseFrontmatter } from '#/_base/text/frontmatter';
import { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { parseAgentFileText } from '#/workspace/workspaceAgentProfileLoader/internal/agentFile';
import { discoverAgentFiles } from '#/workspace/workspaceAgentProfileLoader/internal/agentFileDiscovery';
import { userAgentRoots } from '#/workspace/workspaceAgentProfileLoader/internal/agentRoots';
import type { AgentFileDefinition } from '#/workspace/workspaceAgentProfileLoader/internal/types';

import {
  IUserAgentProfileManagementService,
  UserAgentProfileError,
  type UserAgentProfileBasicInput,
  type UserAgentProfileDetail,
  type UserAgentProfileList,
  type UserAgentProfileRefreshResult,
  type UserAgentProfileUpdateInput,
} from './userAgentProfileManagement';

const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface StoredAgentProfile {
  readonly definition: AgentFileDefinition;
  readonly text: string;
  readonly frontmatter: Record<string, unknown>;
}

export class UserAgentProfileManagementService
  extends Service
  implements IUserAgentProfileManagementService
{
  declare readonly _serviceBrand: undefined;

  private tail: Promise<void> = Promise.resolve();

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IBuiltinAgentProfileLoader private readonly builtin: IBuiltinAgentProfileLoader,
    @IWorkspaceInstanceManager private readonly workspaces: IWorkspaceInstanceManager,
    @ILogService private readonly log: ILogService,
  ) {
    super();
  }

  list(): Promise<UserAgentProfileList> {
    return this.enqueue(() => this.readList());
  }

  getProfile(name: string): Promise<UserAgentProfileDetail> {
    return this.enqueue(async () => (await this.readStored(name)).detail);
  }

  create(input: UserAgentProfileBasicInput) {
    return this.enqueue(async () => {
      const normalized = normalizeBasicInput(input);
      await this.assertNameAvailable(normalized.name);
      const root = await this.root();
      const path = join(root, `${normalized.name}.md`);
      const text = renderAgentFile({}, normalized);
      parseAgentFileText({ path, source: 'user', text });
      await this.fs.mkdir(root, { recursive: true });
      const created = await this.fs.createExclusive(path, Buffer.from(text, 'utf8'));
      if (!created) {
        throw new UserAgentProfileError('already_exists', `Agent profile "${normalized.name}" already exists`);
      }
      const agent = (await this.readStored(normalized.name)).detail;
      const { refreshError } = await this.refreshNow();
      return { agent, refreshError };
    });
  }

  update(name: string, input: UserAgentProfileUpdateInput) {
    return this.enqueue(async () => {
      const current = await this.readStored(name);
      this.assertEtag(current.text, input.etag);
      const normalized = normalizeBasicInput({
        name: input.newName ?? current.definition.name,
        description: input.description,
        prompt: input.prompt,
      });
      await this.assertNameAvailable(normalized.name, {
        name: current.definition.name,
        override: current.frontmatter['override'] === true,
      });
      const nextText = renderAgentFile(current.frontmatter, normalized);
      const nextPath = normalized.name === current.definition.name
        ? current.definition.path
        : join(dirname(current.definition.path), `${normalized.name}.md`);
      parseAgentFileText({ path: nextPath, source: 'user', text: nextText });
      if (nextPath === current.definition.path) {
        await this.replaceText(nextPath, nextText);
      } else {
        const created = await this.fs.createExclusive(nextPath, Buffer.from(nextText, 'utf8'));
        if (!created) {
          throw new UserAgentProfileError('already_exists', `Agent profile "${normalized.name}" already exists`);
        }
        try {
          await this.fs.remove(current.definition.path);
        } catch (error) {
          await this.fs.remove(nextPath).catch(() => undefined);
          throw error;
        }
      }
      const agent = (await this.readStored(normalized.name)).detail;
      const { refreshError } = await this.refreshNow();
      return { agent, refreshError };
    });
  }

  delete(name: string, etag: string): Promise<UserAgentProfileRefreshResult> {
    return this.enqueue(async () => {
      const current = await this.readStored(name);
      this.assertEtag(current.text, etag);
      await this.fs.remove(current.definition.path);
      return this.refreshNow();
    });
  }

  refresh(): Promise<UserAgentProfileRefreshResult> {
    return this.enqueue(() => this.refreshNow());
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.catch(() => undefined).then(operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async root(): Promise<string> {
    const roots = await userAgentRoots(
      this.fs,
      this.bootstrap.homeDir,
      this.bootstrap.osHomeDir,
      (message, error) => this.log.warn(message, error),
    );
    return roots[0]?.path ?? join(this.bootstrap.homeDir, 'agents');
  }

  private async readList(): Promise<UserAgentProfileList> {
    const root = await this.root();
    const result = await discoverAgentFiles(
      this.fs,
      [{ path: root, source: 'user' }],
      (message, error) => this.log.warn(message, error),
    );
    return {
      root,
      agents: result.agents.map((agent) => ({
        name: agent.name,
        description: agent.description,
        path: agent.path,
      })),
      skipped: result.skipped,
    };
  }

  private async readStored(name: string): Promise<StoredAgentProfile & { detail: UserAgentProfileDetail }> {
    assertValidName(name);
    const list = await this.readList();
    const definition = list.agents.find((agent) => agent.name === name);
    if (definition === undefined) {
      throw new UserAgentProfileError('not_found', `Agent profile "${name}" was not found`);
    }
    const text = await this.fs.readText(definition.path);
    const parsed = parseFrontmatter(text);
    if (!isRecord(parsed.data)) {
      throw new UserAgentProfileError('validation', `Frontmatter in ${definition.path} must be a mapping`);
    }
    return {
      definition: {
        name: definition.name,
        description: definition.description,
        override: false,
        prompt: parsed.body.trim(),
        path: definition.path,
        source: 'user',
      },
      text,
      frontmatter: parsed.data,
      detail: {
        ...definition,
        prompt: parsed.body.trim(),
        etag: contentEtag(text),
      },
    };
  }

  private async assertNameAvailable(
    name: string,
    current?: { readonly name: string; readonly override: boolean },
  ): Promise<void> {
    if (current?.name === name) {
      if (this.builtin.get(name) !== undefined && !current.override) {
        throw new UserAgentProfileError('already_exists', `Agent profile "${name}" conflicts with a builtin profile`);
      }
      return;
    }
    if (this.builtin.get(name) !== undefined) {
      throw new UserAgentProfileError('already_exists', `Agent profile "${name}" conflicts with a builtin profile`);
    }
    const list = await this.readList();
    if (list.agents.some((agent) => agent.name === name)) {
      throw new UserAgentProfileError('already_exists', `Agent profile "${name}" already exists`);
    }
  }

  private assertEtag(text: string, expected: string): void {
    if (contentEtag(text) !== expected) {
      throw new UserAgentProfileError('stale', 'Agent profile changed on disk; reload it before saving');
    }
  }

  private async replaceText(path: string, text: string): Promise<void> {
    const rename = this.fs.rename?.bind(this.fs);
    if (rename === undefined) throw new Error('Host filesystem does not support atomic rename');
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await this.fs.writeText(temporary, text);
      await rename(temporary, path);
    } catch (error) {
      await this.fs.remove(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async refreshNow(): Promise<UserAgentProfileRefreshResult> {
    const results = await Promise.allSettled(
      this.workspaces.list().map((workspace) => workspace.program.reload()),
    );
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length === 0) return {};
    for (const failure of failures) {
      this.log.error('agent profile workspace refresh failed', failure.reason);
    }
    return { refreshError: `${failures.length} workspace(s) failed to refresh` };
  }
}

function normalizeBasicInput(input: UserAgentProfileBasicInput): UserAgentProfileBasicInput {
  const name = input.name.trim();
  assertValidName(name);
  const description = input.description.trim();
  if (description.length === 0) {
    throw new UserAgentProfileError('validation', 'Agent profile description is required');
  }
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    throw new UserAgentProfileError('validation', 'Agent profile prompt is required');
  }
  return { name, description, prompt };
}

function assertValidName(name: string): void {
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new UserAgentProfileError(
      'validation',
      `Invalid agent name "${name}": expected kebab-case (e.g. "code-reviewer")`,
    );
  }
}

function renderAgentFile(
  frontmatter: Record<string, unknown>,
  input: UserAgentProfileBasicInput,
): string {
  const yaml = dump(
    { ...frontmatter, name: input.name, description: input.description },
    { lineWidth: -1, noRefs: true },
  );
  return `---\n${yaml}---\n\n${input.prompt}\n`;
}

function contentEtag(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

registerScopedService(
  LifecycleScope.App,
  IUserAgentProfileManagementService,
  UserAgentProfileManagementService,
  ScopeActivation.OnScopeCreated,
  'agentProfileManagement',
);
