import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { canonicalWorkspaceRoot } from '#/_base/utils/paths';

import { ErrorCodes, Error2 } from '#/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { loadMcpServersDetailed } from '#/app/mcpConfig/configLoader';
import { IMcpConfigStore } from '#/app/mcpConfig/configStore';
import { IPluginService } from '#/app/plugin/plugin';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { readWorkspaceTrust } from '#/workspace/workspaceTrust/trustRecord';

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
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
  ) {}

  async list(query: McpRegistryQuery = {}): Promise<readonly McpRegistryEntry[]> {
    const out: McpRegistryEntry[] = [];

    if (query.cwd === undefined) {
      const userEntries = await this.store.list();
      for (const server of userEntries) {
        const { name, ...config } = server;
        out.push({
          name,
          config,
          source: 'global',
          origin: this.store.path,
          mutable: true,
        });
      }
    } else {
      const cwd = canonicalWorkspaceRoot(query.cwd);
      if (!(await readWorkspaceTrust(this.docs, cwd))) {
        const userEntries = await this.store.list();
        for (const server of userEntries) {
          const { name, ...config } = server;
          out.push({
            name,
            config,
            source: 'global',
            origin: this.store.path,
            mutable: true,
          });
        }
      } else {
        const detailed = await loadMcpServersDetailed({
          fs: this.fs,
          cwd,
          homeDir: this.bootstrap.homeDir,
        });
        for (const [name, config] of Object.entries(detailed.servers)) {
          const origin = detailed.origins[name] ?? this.store.path;
          out.push({
            name,
            config,
            source: 'global',
            origin,
            mutable: origin === this.store.path,
          });
        }
      }
    }

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
}

registerScopedService(
  LifecycleScope.App,
  IMcpRegistryService,
  McpRegistryService,
  ScopeActivation.OnDemand,
  'mcpRegistry',
);
