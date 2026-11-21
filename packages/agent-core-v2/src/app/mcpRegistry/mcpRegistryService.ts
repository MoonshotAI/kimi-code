import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { resolvePath } from '#/_base/utils/paths';

import { ErrorCodes, Error2 } from '#/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { findMcpAnchor, loadMcpServersDetailed } from '#/app/mcpConfig/configLoader';
import { IMcpConfigStore } from '#/app/mcpConfig/configStore';
import { IPluginService } from '#/app/plugin/plugin';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IWorkspaceTrustStore } from '#/workspace/workspaceTrust/workspaceTrustStore';

import {
  IMcpRegistryService,
  type McpRegistryEntry,
  type McpRegistryQuery,
} from './mcpRegistry';

export class McpRegistryService implements IMcpRegistryService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IMcpConfigStore private readonly store: IMcpConfigStore,
    @IPluginService private readonly plugins: IPluginService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IWorkspaceTrustStore private readonly trust: IWorkspaceTrustStore,
    @IWorkspaceService private readonly workspaces: IWorkspaceService,
  ) {}

  async list(query: McpRegistryQuery = {}): Promise<readonly McpRegistryEntry[]> {
    const out: McpRegistryEntry[] = query.cwd === undefined
      ? await this.userEntries()
      : await this.entriesAt(resolvePath(process.cwd(), query.cwd));

    for (const entry of await this.plugins.mcpServerEntries()) {
      out.push({
        name: entry.name,
        config: entry.config,
        source: 'plugin',
        origin: entry.pluginId,
        mutable: false,
        plugin: { id: entry.pluginId, name: entry.serverName },
      });
    }

    return out;
  }

  async get(name: string, query: McpRegistryQuery = {}): Promise<McpRegistryEntry> {
    const entry = (await this.list(query)).find((candidate) => candidate.name === name);
    if (entry !== undefined) return entry;
    throw new Error2(ErrorCodes.MCP_SERVER_NOT_FOUND, `MCP server "${name}" was not found`);
  }

  async resolveRuntimeTarget(
    name: string,
    query: McpRegistryQuery = {},
  ): Promise<McpRegistryEntry | undefined> {
    const matches = (await this.list(query)).filter((entry) => entry.name === name);
    const file = matches.find((entry) => entry.source === 'global');
    if (file !== undefined) return file;
    return matches.find((entry) => entry.source === 'plugin' && entry.config.enabled !== false);
  }

  private async userEntries(): Promise<McpRegistryEntry[]> {
    return (await this.store.list()).map(({ name, ...config }) => ({
      name,
      config,
      source: 'global',
      origin: this.store.path,
      mutable: true,
    }));
  }

  private async entriesAt(cwd: string): Promise<McpRegistryEntry[]> {
    const decision = await this.workspaces.peekImplicit(cwd);
    const project = decision.kind === 'reuse' ? decision.project : { root: decision.root, additionalDirs: [] };
    if (!(await this.trust.forProject(project).refresh())) return this.userEntries();
    const detailed = await loadMcpServersDetailed({
      fs: this.fs,
      cwd,
      homeDir: this.bootstrap.homeDir,
      anchor: (await findMcpAnchor(this.fs, cwd, project)).anchor,
    });
    return Object.entries(detailed.servers).map(([name, config]) => {
      const origin = detailed.origins[name] ?? this.store.path;
      return { name, config, source: 'global', origin, mutable: origin === this.store.path };
    });
  }
}

registerScopedService(
  LifecycleScope.App,
  IMcpRegistryService,
  McpRegistryService,
  ScopeActivation.OnDemand,
  'mcpRegistry',
);
