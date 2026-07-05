import { createInterface } from 'node:readline/promises';
import { homedir as osHomedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Command } from 'commander';

import {
  createKimiHarness,
  type KimiHarness,
  type PluginInfo,
  type PluginSummary,
  type TelemetryClient,
} from '@moonshot-ai/kimi-code-sdk';
import {
  setTelemetryContext,
  shutdownTelemetry,
  track,
  withTelemetryContext,
} from '@moonshot-ai/kimi-telemetry';

import { CLI_SHUTDOWN_TIMEOUT_MS, CLI_UI_MODE } from '#/constant/app';
import { createCliTelemetryBootstrap, initializeCliTelemetry } from '#/cli/telemetry';
import { createKimiCodeHostIdentity } from '#/cli/version';
import {
  addRegistry,
  readRegistries,
  removeRegistry,
  resolveRegistryUrl,
} from '#/utils/plugin-registries';
import { loadMergedMarketplace, loadPluginMarketplace } from '#/utils/plugin-marketplace';
import {
  formatPluginSourceLabel,
  isOfficialPluginSource,
} from '#/tui/utils/plugin-source-label';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface PluginsDeps {
  readonly getHarness: () => KimiHarness;
  readonly getHomeDir: () => string;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly cwd: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
  readonly addRegistry: (homeDir: string, registry: { url: string; name?: string }) => Promise<void>;
  readonly readRegistries: (homeDir: string) => Promise<{ registries: ReadonlyArray<{ name?: string; url: string }> }>;
  readonly removeRegistry: (homeDir: string, nameOrUrl: string) => Promise<void>;
  readonly resolveRegistryUrl: (homeDir: string, nameOrUrl: string) => Promise<string>;
  readonly loadPluginMarketplace: typeof loadPluginMarketplace;
  readonly loadMergedMarketplace: typeof loadMergedMarketplace;
}

export interface ListOptions {
  readonly json?: boolean;
}

export interface InstallOptions {
  readonly yes?: boolean;
}

export interface RemoveOptions {
  readonly yes?: boolean;
}

export interface InfoOptions {
  readonly json?: boolean;
}

export interface MarketplaceOptions {
  readonly registry?: string;
  readonly json?: boolean;
}

export interface RegistryAddOptions {
  readonly name?: string;
}

export interface RegistryListOptions {
  readonly json?: boolean;
}

export async function handlePluginsList(
  deps: PluginsDeps,
  options: ListOptions,
): Promise<void> {
  try {
    const plugins = await deps.getHarness().listPlugins();
    if (options.json) {
      deps.stdout.write(`${JSON.stringify(plugins, null, 2)}\n`);
      return;
    }
    if (plugins.length === 0) {
      deps.stdout.write('No plugins installed.\n');
      return;
    }
    deps.stdout.write(formatPluginsTable(plugins));
  } catch (error) {
    deps.stderr.write(`Failed to list plugins: ${errorMessage(error)}\n`);
    deps.exit(1);
  }
}

export async function handlePluginsInfo(
  deps: PluginsDeps,
  id: string,
  options: InfoOptions,
): Promise<void> {
  try {
    const info = await deps.getHarness().getPluginInfo(id);
    if (options.json) {
      deps.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
      return;
    }
    deps.stdout.write(formatPluginInfo(info));
  } catch (error) {
    deps.stderr.write(`Failed to get plugin info: ${errorMessage(error)}\n`);
    deps.exit(1);
  }
}

export async function handlePluginsInstall(
  deps: PluginsDeps,
  options: { source: string } & InstallOptions,
): Promise<void> {
  try {
    const source = resolvePluginInstallSource(options.source, deps.cwd());
    const official = isOfficialPluginSource(source);
    if (!official && !options.yes) {
      const confirmed = await deps.confirm(
        `Install plugin from third-party source "${source}"? [y/N] `,
      );
      if (!confirmed) {
        deps.stdout.write('Install cancelled.\n');
        return;
      }
    }
    const summary = await deps.getHarness().installPlugin(source);
    deps.stdout.write(`Installed ${summary.displayName} (${summary.id}).\n`);
  } catch (error) {
    deps.stderr.write(`Failed to install plugin: ${errorMessage(error)}\n`);
    deps.exit(1);
  }
}

export async function handlePluginsRemove(
  deps: PluginsDeps,
  options: { id: string } & RemoveOptions,
): Promise<void> {
  try {
    const info = await deps.getHarness().getPluginInfo(options.id);
    if (!options.yes) {
      const confirmed = await deps.confirm(
        `Remove plugin "${info.displayName}" (${info.id})? [y/N] `,
      );
      if (!confirmed) {
        deps.stdout.write('Remove cancelled.\n');
        return;
      }
    }
    await deps.getHarness().removePlugin(options.id);
    deps.stdout.write(`Removed ${options.id}.\n`);
  } catch (error) {
    deps.stderr.write(`Failed to remove plugin: ${errorMessage(error)}\n`);
    deps.exit(1);
  }
}

export async function handlePluginsEnable(
  deps: PluginsDeps,
  options: { id: string; enabled: boolean },
): Promise<void> {
  try {
    await deps.getHarness().setPluginEnabled(options.id, options.enabled);
    deps.stdout.write(`${options.enabled ? 'Enabled' : 'Disabled'} ${options.id}.\n`);
  } catch (error) {
    deps.stderr.write(`Failed to ${options.enabled ? 'enable' : 'disable'} plugin: ${errorMessage(error)}\n`);
    deps.exit(1);
  }
}

export async function handlePluginsMarketplace(
  deps: PluginsDeps,
  options: MarketplaceOptions,
): Promise<void> {
  try {
    const homeDir = deps.getHomeDir();
    let marketplace;
    if (options.registry !== undefined) {
      const source = await deps.resolveRegistryUrl(homeDir, options.registry);
      marketplace = await deps.loadPluginMarketplace({
        workDir: deps.cwd(),
        source,
      });
    } else {
      marketplace = await deps.loadMergedMarketplace({
        kimiHomeDir: homeDir,
        workDir: deps.cwd(),
      });
    }
    if (options.json) {
      deps.stdout.write(`${JSON.stringify(marketplace.plugins, null, 2)}\n`);
      return;
    }
    if (marketplace.plugins.length === 0) {
      deps.stdout.write('No plugins available.\n');
      return;
    }
    deps.stdout.write(formatMarketplaceTable(marketplace.plugins));
  } catch (error) {
    deps.stderr.write(`Failed to load marketplace: ${errorMessage(error)}\n`);
    deps.exit(1);
  }
}

export async function handlePluginsRegistryList(
  deps: PluginsDeps,
  options: RegistryListOptions,
): Promise<void> {
  try {
    const file = await deps.readRegistries(deps.getHomeDir());
    if (options.json) {
      deps.stdout.write(`${JSON.stringify(file.registries, null, 2)}\n`);
      return;
    }
    if (file.registries.length === 0) {
      deps.stdout.write('No custom registries.\n');
      return;
    }
    deps.stdout.write(formatRegistriesTable(file.registries));
  } catch (error) {
    deps.stderr.write(`Failed to list registries: ${errorMessage(error)}\n`);
    deps.exit(1);
  }
}

export async function handlePluginsRegistryAdd(
  deps: PluginsDeps,
  options: { url: string } & RegistryAddOptions,
): Promise<void> {
  try {
    await deps.addRegistry(deps.getHomeDir(), {
      url: options.url,
      name: options.name,
    });
    deps.stdout.write(`Added registry ${options.name ?? options.url}.\n`);
  } catch (error) {
    deps.stderr.write(`Failed to add registry: ${errorMessage(error)}\n`);
    deps.exit(1);
  }
}

export async function handlePluginsRegistryRemove(
  deps: PluginsDeps,
  options: { nameOrUrl: string },
): Promise<void> {
  try {
    await deps.removeRegistry(deps.getHomeDir(), options.nameOrUrl);
    deps.stdout.write(`Removed registry ${options.nameOrUrl}.\n`);
  } catch (error) {
    deps.stderr.write(`Failed to remove registry: ${errorMessage(error)}\n`);
    deps.exit(1);
  }
}

export function registerPluginsCommand(parent: Command, deps?: Partial<PluginsDeps>): void {
  const runWithLifecycle = async (fn: (d: DefaultPluginsDeps) => Promise<void>): Promise<void> => {
    const d = createDefaultPluginsDeps(deps);
    try {
      await d.initializeDefaultTelemetry();
      await fn(d);
    } finally {
      await d.shutdownDefaultTelemetry();
      await d.closeDefaultHarness();
    }
  };

  const program = parent.command('plugins').description('Manage Kimi Code plugins.');

  program
    .command('list')
    .description('List installed plugins.')
    .option('--json', 'Output as JSON.')
    .action(async (options: { json?: boolean }) => {
      await runWithLifecycle((d) => handlePluginsList(d, options));
    });

  program
    .command('info <id>')
    .description('Show details of an installed plugin.')
    .option('--json', 'Output as JSON.')
    .action(async (id: string, options: { json?: boolean }) => {
      await runWithLifecycle((d) => handlePluginsInfo(d, id, options));
    });

  program
    .command('install <source>')
    .description('Install a plugin from a local path, zip URL, or GitHub URL.')
    .option('-y, --yes', 'Skip trust confirmation for third-party sources.')
    .action(async (source: string, options: { yes?: boolean }) => {
      await runWithLifecycle((d) => handlePluginsInstall(d, { source, yes: options.yes }));
    });

  program
    .command('remove <id>')
    .description('Remove an installed plugin.')
    .option('-y, --yes', 'Skip confirmation.')
    .action(async (id: string, options: { yes?: boolean }) => {
      await runWithLifecycle((d) => handlePluginsRemove(d, { id, yes: options.yes }));
    });

  program
    .command('enable <id>')
    .description('Enable an installed plugin.')
    .action(async (id: string) => {
      await runWithLifecycle((d) => handlePluginsEnable(d, { id, enabled: true }));
    });

  program
    .command('disable <id>')
    .description('Disable an installed plugin.')
    .action(async (id: string) => {
      await runWithLifecycle((d) => handlePluginsEnable(d, { id, enabled: false }));
    });

  program
    .command('marketplace')
    .description('List available plugins from the marketplace and custom registries.')
    .option('--registry <name-or-url>', 'Use a specific registry.')
    .option('--json', 'Output as JSON.')
    .action(async (options: { registry?: string; json?: boolean }) => {
      await runWithLifecycle((d) => handlePluginsMarketplace(d, options));
    });

  const registry = program.command('registry').description('Manage custom plugin registries.');

  registry
    .command('list')
    .description('List custom registries.')
    .option('--json', 'Output as JSON.')
    .action(async (options: { json?: boolean }) => {
      await runWithLifecycle((d) => handlePluginsRegistryList(d, options));
    });

  registry
    .command('add <url>')
    .description('Add a custom registry.')
    .option('--name <name>', 'Optional display name.')
    .action(async (url: string, options: { name?: string }) => {
      await runWithLifecycle((d) => handlePluginsRegistryAdd(d, { url, name: options.name }));
    });

  registry
    .command('remove <name-or-url>')
    .description('Remove a custom registry by name or URL.')
    .action(async (nameOrUrl: string) => {
      await runWithLifecycle((d) => handlePluginsRegistryRemove(d, { nameOrUrl }));
    });
}

interface DefaultPluginsDeps extends PluginsDeps {
  readonly initializeDefaultTelemetry: () => Promise<void>;
  readonly shutdownDefaultTelemetry: () => Promise<void>;
  readonly closeDefaultHarness: () => Promise<void>;
}

function createDefaultPluginsDeps(overrides: Partial<PluginsDeps> = {}): DefaultPluginsDeps {
  let harness: KimiHarness | undefined;
  let telemetryBootstrap: ReturnType<typeof createCliTelemetryBootstrap> | undefined;
  let telemetryInitialized = false;
  let telemetryShutdown = false;
  const identity = createKimiCodeHostIdentity();
  const telemetryClient: TelemetryClient = {
    track,
    withContext: withTelemetryContext,
    setContext: setTelemetryContext,
  };
  const getTelemetryBootstrap = (): ReturnType<typeof createCliTelemetryBootstrap> => {
    telemetryBootstrap ??= createCliTelemetryBootstrap();
    return telemetryBootstrap;
  };
  const getHarness = (): KimiHarness => {
    const currentTelemetryBootstrap = getTelemetryBootstrap();
    harness ??= createKimiHarness({
      homeDir: currentTelemetryBootstrap.homeDir,
      identity,
      telemetry: telemetryClient,
      uiMode: CLI_UI_MODE,
    });
    return harness;
  };
  const initializeDefaultTelemetry = async (): Promise<void> => {
    if (telemetryInitialized) return;
    const currentTelemetryBootstrap = getTelemetryBootstrap();
    const currentHarness = getHarness();
    await currentHarness.ensureConfigFile();
    const config = await currentHarness.getConfig();
    initializeCliTelemetry({
      harness: currentHarness,
      bootstrap: currentTelemetryBootstrap,
      config,
      version: identity.version,
      uiMode: CLI_UI_MODE,
    });
    telemetryInitialized = true;
  };
  const shutdownDefaultTelemetry = async (): Promise<void> => {
    if (!telemetryInitialized || telemetryShutdown) return;
    telemetryShutdown = true;
    await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS });
  };
  const closeDefaultHarness = async (): Promise<void> => {
    if (harness === undefined) return;
    const currentHarness = harness;
    harness = undefined;
    await currentHarness.close();
  };
  const getHomeDir = (): string => getTelemetryBootstrap().homeDir;
  return {
    getHarness: overrides.getHarness ?? getHarness,
    getHomeDir: overrides.getHomeDir ?? getHomeDir,
    cwd: overrides.cwd ?? (() => process.cwd()),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    exit: overrides.exit ?? ((code: number) => process.exit(code)),
    confirm: overrides.confirm ?? confirmPrompt,
    addRegistry: overrides.addRegistry ?? addRegistry,
    readRegistries: overrides.readRegistries ?? readRegistries,
    removeRegistry: overrides.removeRegistry ?? removeRegistry,
    resolveRegistryUrl: overrides.resolveRegistryUrl ?? resolveRegistryUrl,
    loadPluginMarketplace: overrides.loadPluginMarketplace ?? loadPluginMarketplace,
    loadMergedMarketplace: overrides.loadMergedMarketplace ?? loadMergedMarketplace,
    initializeDefaultTelemetry,
    shutdownDefaultTelemetry,
    closeDefaultHarness,
  };
}

async function confirmPrompt(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(message);
    const trimmed = answer.trim().toLowerCase();
    return trimmed === 'y' || trimmed === 'yes';
  } finally {
    rl.close();
  }
}

function resolvePluginInstallSource(source: string, workDir: string): string {
  const trimmed = source.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed === '~') return osHomedir();
  if (trimmed.startsWith('~/')) return join(osHomedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed : resolve(workDir, trimmed);
}

function formatPluginsTable(plugins: readonly PluginSummary[]): string {
  const lines = plugins.map((p) => {
    const status = p.enabled ? 'enabled' : 'disabled';
    const version = p.version ?? '-';
    return `${p.id}\t${p.displayName}\t${version}\t${status}\t${formatPluginSourceLabel(p)}`;
  });
  return ['ID\tNAME\tVERSION\tSTATUS\tSOURCE', ...lines, ''].join('\n');
}

function formatPluginInfo(info: PluginInfo): string {
  const lines = [
    `ID:        ${info.id}`,
    `Name:      ${info.displayName}`,
    `Version:   ${info.version ?? '-'}`,
    `Enabled:   ${info.enabled}`,
    `State:     ${info.state}`,
    `Source:    ${formatPluginSourceLabel(info)}`,
    `Skills:    ${info.skillCount}`,
    `MCP:       ${info.enabledMcpServerCount}/${info.mcpServerCount}`,
    `Hooks:     ${info.hookCount}`,
    `Commands:  ${info.commandCount}`,
  ];
  return `${lines.join('\n')}\n`;
}

function formatMarketplaceTable(
  plugins: ReadonlyArray<{ id: string; displayName: string; version?: string; description?: string }>,
): string {
  const lines = plugins.map((p) => {
    const version = p.version ?? '-';
    return `${p.id}\t${p.displayName}\t${version}\t${p.description ?? ''}`;
  });
  return ['ID\tNAME\tVERSION\tDESCRIPTION', ...lines, ''].join('\n');
}

function formatRegistriesTable(
  registries: ReadonlyArray<{ name?: string; url: string }>,
): string {
  const lines = registries.map((r) => `${r.name ?? '-'}\t${r.url}`);
  return ['NAME\tURL', ...lines, ''].join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
