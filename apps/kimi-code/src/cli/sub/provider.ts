/**
 * `kimi provider` sub-command — non-interactive provider management.
 *
 * Mirrors the TUI `/provider` flow (apps/kimi-code/src/tui/commands/provider.ts)
 * for the custom-registry path so users can import an api.json document, drop
 * a provider, or inspect what is configured without launching the TUI.
 *
 * `add` writes the same `source = { kind: 'apiJson', url, apiKey }` blob the
 * TUI does; the next launch's `refreshAllProviderModels`
 * (apps/kimi-code/src/tui/utils/refresh-providers.ts) groups by `{url, apiKey}`
 * and re-fetches the model list, so periodic refresh is automatic.
 */

import {
  applyCustomRegistryProvider,
  CustomRegistryApiError,
  fetchCustomRegistry,
  type CustomRegistrySource,
  type ManagedKimiConfigShape,
} from '@moonshot-ai/kimi-code-oauth';
import {
  applyCatalogProvider,
  catalogBaseUrl,
  catalogProviderModels,
  CatalogFetchError,
  createKimiHarness,
  DEFAULT_CATALOG_URL,
  fetchCatalog,
  inferWireType,
  type Catalog,
  type CatalogProviderEntry,
  type KimiConfig,
  type KimiHarness,
} from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';

import { createKimiCodeHostIdentity } from '#/cli/version';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface ProviderDeps {
  readonly getHarness: () => KimiHarness;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly env: NodeJS.ProcessEnv;
  readonly exit: (code: number) => never;
}

interface AddOptions {
  readonly apiKey?: string;
}

interface ListOptions {
  readonly json: boolean;
}

interface CatalogListOptions {
  readonly json: boolean;
  readonly filter?: string;
  readonly url?: string;
}

interface CatalogAddOptions {
  readonly apiKey?: string;
  readonly defaultModel?: string;
  readonly url?: string;
}

export async function handleProviderAdd(
  deps: ProviderDeps,
  url: string,
  opts: AddOptions,
): Promise<void> {
  const apiKey = resolveApiKey(opts.apiKey, deps.env);
  if (apiKey === undefined) {
    deps.stderr.write(
      'Missing API key. Pass --api-key <key> or set KIMI_REGISTRY_API_KEY.\n',
    );
    deps.exit(1);
  }

  const trimmedUrl = url.trim();
  if (trimmedUrl.length === 0) {
    deps.stderr.write('Registry URL is required.\n');
    deps.exit(1);
  }

  const source: CustomRegistrySource = {
    kind: 'apiJson',
    url: trimmedUrl,
    apiKey,
  };

  const harness = deps.getHarness();
  await harness.ensureConfigFile();

  let entries: Awaited<ReturnType<typeof fetchCustomRegistry>>;
  try {
    entries = await fetchCustomRegistry(source);
  } catch (error) {
    const suffix = error instanceof CustomRegistryApiError ? ` (HTTP ${String(error.status)})` : '';
    deps.stderr.write(`Failed to fetch registry${suffix}: ${errorMessage(error)}\n`);
    deps.exit(1);
  }

  const entryList = Object.values(entries);
  if (entryList.length === 0) {
    deps.stderr.write(`Registry at ${trimmedUrl} contained no usable providers.\n`);
    deps.exit(1);
  }

  // `harness.removeProvider` reloads the config from disk on each call (see
  // `core-impl.ts removeKimiProvider`), so calling it inside the apply loop
  // would discard providers we already applied in memory but have not yet
  // persisted. Drop every stale id up front in a single batch instead, then
  // apply against the resulting fresh config.
  let config = await harness.getConfig();
  const staleIds = entryList
    .filter((entry) => config.providers[entry.id] !== undefined)
    .map((entry) => entry.id);
  for (const id of staleIds) {
    config = await harness.removeProvider(id);
  }

  const addedProviderIds: string[] = [];
  let modelCount = 0;
  for (const entry of entryList) {
    applyCustomRegistryProvider(asManaged(config), entry, source);
    addedProviderIds.push(entry.id);
    modelCount += Object.keys(entry.models).length;
  }

  await harness.setConfig({
    providers: config.providers,
    models: config.models,
  });

  deps.stdout.write(
    `Imported ${String(addedProviderIds.length)} provider${addedProviderIds.length === 1 ? '' : 's'} ` +
      `(${String(modelCount)} model${modelCount === 1 ? '' : 's'}) from ${trimmedUrl}:\n`,
  );
  for (const id of addedProviderIds) {
    deps.stdout.write(`  - ${id}\n`);
  }
}

export async function handleProviderRemove(
  deps: ProviderDeps,
  providerId: string,
): Promise<void> {
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await harness.getConfig();
  if (config.providers[providerId] === undefined) {
    deps.stderr.write(`Provider "${providerId}" not found.\n`);
    deps.exit(1);
  }
  await harness.removeProvider(providerId);
  deps.stdout.write(`Removed provider "${providerId}".\n`);
}

export async function handleProviderList(
  deps: ProviderDeps,
  opts: ListOptions,
): Promise<void> {
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await harness.getConfig();

  if (opts.json) {
    deps.stdout.write(
      `${JSON.stringify({ providers: config.providers, models: config.models ?? {} }, null, 2)}\n`,
    );
    return;
  }

  const modelsByProvider = new Map<string, string[]>();
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    const list = modelsByProvider.get(model.provider) ?? [];
    list.push(alias);
    modelsByProvider.set(model.provider, list);
  }

  const providerIds = Object.keys(config.providers).toSorted();
  if (providerIds.length === 0) {
    deps.stdout.write('No providers configured.\n');
    return;
  }

  for (const id of providerIds) {
    const provider = config.providers[id]!;
    const aliases = modelsByProvider.get(id) ?? [];
    const sourceLabel = providerSourceLabel(provider);
    deps.stdout.write(
      `${id}  type=${provider.type}  models=${String(aliases.length)}  source=${sourceLabel}\n`,
    );
  }
  if (config.defaultModel !== undefined) {
    deps.stdout.write(`\nDefault model: ${config.defaultModel}\n`);
  }
}

/**
 * Fetches the models.dev-style public catalog and lists providers, or — when
 * `providerId` is given — drills into one provider and lists its models. This
 * mirrors the discovery half of the TUI "Known third-party provider" flow.
 */
export async function handleCatalogList(
  deps: ProviderDeps,
  providerId: string | undefined,
  opts: CatalogListOptions,
): Promise<void> {
  const url = opts.url ?? DEFAULT_CATALOG_URL;
  const catalog = await loadCatalogOrExit(deps, url);

  if (providerId !== undefined) {
    const entry = catalog[providerId];
    if (entry === undefined) {
      deps.stderr.write(`Provider "${providerId}" not found in catalog at ${url}.\n`);
      deps.exit(1);
    }
    const models = catalogProviderModels(entry);
    if (opts.json) {
      deps.stdout.write(
        `${JSON.stringify({ providerId, name: entry.name ?? providerId, models }, null, 2)}\n`,
      );
      return;
    }
    if (models.length === 0) {
      deps.stdout.write(`Provider "${providerId}" lists no usable models in this catalog.\n`);
      return;
    }
    deps.stdout.write(`${entry.name ?? providerId} (${providerId})\n`);
    for (const model of models) {
      const cap: string[] = [];
      if (model.capability.tool_use) cap.push('tool_use');
      if (model.capability.thinking) cap.push('thinking');
      if (model.capability.image_in) cap.push('image_in');
      const ctx =
        typeof model.capability.max_context_tokens === 'number'
          ? String(model.capability.max_context_tokens)
          : '?';
      const capLabel = cap.length > 0 ? ` [${cap.join(',')}]` : '';
      deps.stdout.write(`  ${model.id}  ctx=${ctx}${capLabel}\n`);
    }
    return;
  }

  const filter = opts.filter?.toLowerCase();
  const entries = Object.entries(catalog)
    .filter(([id, entry]) => {
      if (filter === undefined) return true;
      const haystack = `${id} ${entry.name ?? ''}`.toLowerCase();
      return haystack.includes(filter);
    })
    .toSorted(([a], [b]) => a.localeCompare(b));

  if (opts.json) {
    const out: Record<string, CatalogProviderEntry> = {};
    for (const [id, entry] of entries) out[id] = entry;
    deps.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }

  if (entries.length === 0) {
    if (filter !== undefined) {
      deps.stdout.write(`No providers in catalog match "${filter}".\n`);
    } else {
      deps.stdout.write('Catalog is empty.\n');
    }
    return;
  }

  for (const [id, entry] of entries) {
    const modelCount = entry.models === undefined ? 0 : Object.keys(entry.models).length;
    const wire = inferWireType(entry) ?? '?';
    deps.stdout.write(
      `${id}  wire=${wire}  models=${String(modelCount)}  ${entry.name ?? ''}\n`,
    );
  }
}

/**
 * Imports a known provider from the models.dev catalog by id. Unlike
 * `provider add` (which expects a custom api.json), this command relies on
 * the catalog's normalized metadata to fill in context limits and capabilities.
 */
export async function handleCatalogAdd(
  deps: ProviderDeps,
  providerId: string,
  opts: CatalogAddOptions,
): Promise<void> {
  const apiKey = resolveApiKey(opts.apiKey, deps.env);
  if (apiKey === undefined) {
    deps.stderr.write(
      'Missing API key. Pass --api-key <key> or set KIMI_REGISTRY_API_KEY.\n',
    );
    deps.exit(1);
  }

  const url = opts.url ?? DEFAULT_CATALOG_URL;
  const catalog = await loadCatalogOrExit(deps, url);

  const entry = catalog[providerId];
  if (entry === undefined) {
    deps.stderr.write(`Provider "${providerId}" not found in catalog at ${url}.\n`);
    deps.exit(1);
  }

  const wire = inferWireType(entry);
  if (wire === undefined) {
    deps.stderr.write(`Provider "${providerId}" has an unsupported wire type in the catalog.\n`);
    deps.exit(1);
  }

  const models = catalogProviderModels(entry);
  if (models.length === 0) {
    deps.stderr.write(`Provider "${providerId}" lists no usable models in this catalog.\n`);
    deps.exit(1);
  }

  if (opts.defaultModel !== undefined && !models.some((m) => m.id === opts.defaultModel)) {
    deps.stderr.write(
      `Model "${opts.defaultModel}" is not in provider "${providerId}". Run "kimi provider catalog list ${providerId}" to see available ids.\n`,
    );
    deps.exit(1);
  }

  const harness = deps.getHarness();
  await harness.ensureConfigFile();

  let config = await harness.getConfig();

  // Capture defaults BEFORE `removeProvider`, because that call clears
  // `defaultModel` when it points at one of this provider's aliases (see
  // `core-impl.ts removeKimiProvider`). Without this, re-importing an
  // already-configured provider would lose the user's previously-set default
  // even when `--default-model` is not supplied.
  const previousDefaultModel = config.defaultModel;
  const previousDefaultThinking = config.defaultThinking;

  if (config.providers[providerId] !== undefined) {
    config = await harness.removeProvider(providerId);
  }

  const baseUrl = catalogBaseUrl(entry, wire);
  // `applyCatalogProvider` always overwrites both `defaultModel` and
  // `defaultThinking`. The values we pass here are temporary; we restore
  // a consistent state in the post-apply block below.
  applyCatalogProvider(config, {
    providerId,
    wire,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    apiKey,
    models,
    selectedModelId: opts.defaultModel ?? '',
    thinking: false,
  });

  // Resolve the final `defaultModel`:
  //   - If the caller asked for one, `applyCatalogProvider` already set it.
  //   - Else, restore the previous default ONLY when its alias still resolves
  //     after the catalog refresh; the catalog may have dropped the old
  //     model, in which case restoring would point default_model at a
  //     non-existent alias and break the next session.
  if (opts.defaultModel === undefined) {
    const stillResolves =
      previousDefaultModel !== undefined &&
      config.models?.[previousDefaultModel] !== undefined;
    config.defaultModel = stillResolves ? previousDefaultModel : undefined;
  }

  // Always restore `defaultThinking` from what was there before — including
  // `undefined`. Persisting `false` when the user never set it would make
  // `resolveThinkingLevel` (agent-core/src/agent/config/thinking.ts) treat
  // it as an explicit "off" request and silently disable thinking, even
  // for thinking-capable models.
  config.defaultThinking = previousDefaultThinking;

  await harness.setConfig({
    providers: config.providers,
    models: config.models,
    defaultModel: config.defaultModel,
    defaultThinking: config.defaultThinking,
  });

  const displayName = entry.name ?? providerId;
  deps.stdout.write(
    `Imported ${displayName} (${providerId}) with ${String(models.length)} model${models.length === 1 ? '' : 's'} from ${url}.\n`,
  );
  if (opts.defaultModel !== undefined) {
    deps.stdout.write(`Default model set to ${providerId}/${opts.defaultModel}.\n`);
  }
}

async function loadCatalogOrExit(deps: ProviderDeps, url: string): Promise<Catalog> {
  try {
    return await fetchCatalog(url);
  } catch (error) {
    const suffix = error instanceof CatalogFetchError ? ` (HTTP ${String(error.status)})` : '';
    deps.stderr.write(`Failed to fetch catalog from ${url}${suffix}: ${errorMessage(error)}\n`);
    deps.exit(1);
  }
}

export function registerProviderCommand(parent: Command, deps?: Partial<ProviderDeps>): void {
  const provider = parent
    .command('provider')
    .description('Manage LLM providers non-interactively.');

  provider
    .command('add <url>')
    .description('Import every provider listed in a custom registry (api.json).')
    .option('--api-key <key>', 'Registry API key. Falls back to KIMI_REGISTRY_API_KEY.')
    .action(async (url: string, options: { apiKey?: string }) => {
      const resolved = resolveDeps(deps);
      await handleProviderAdd(resolved, url, { apiKey: options.apiKey });
    });

  provider
    .command('remove <providerId>')
    .description('Remove a provider and every model alias that referenced it.')
    .action(async (providerId: string) => {
      const resolved = resolveDeps(deps);
      await handleProviderRemove(resolved, providerId);
    });

  provider
    .command('list')
    .description('Show configured providers and their model counts.')
    .option('--json', 'Emit the raw providers/models config as JSON.', false)
    .action(async (options: { json?: boolean }) => {
      const resolved = resolveDeps(deps);
      await handleProviderList(resolved, { json: options.json === true });
    });

  const catalog = provider
    .command('catalog')
    .description('Discover and import providers from the public models.dev catalog.');

  catalog
    .command('list [providerId]')
    .description('List providers in the catalog, or models when a providerId is given.')
    .option('--filter <substring>', 'Case-insensitive id/name substring filter.')
    .option('--url <url>', `Override catalog URL. Defaults to ${DEFAULT_CATALOG_URL}.`)
    .option('--json', 'Emit the matching catalog slice as JSON.', false)
    .action(
      async (
        providerId: string | undefined,
        options: { filter?: string; url?: string; json?: boolean },
      ) => {
        const resolved = resolveDeps(deps);
        await handleCatalogList(resolved, providerId, {
          json: options.json === true,
          ...(options.filter === undefined ? {} : { filter: options.filter }),
          ...(options.url === undefined ? {} : { url: options.url }),
        });
      },
    );

  catalog
    .command('add <providerId>')
    .description('Import a known provider from the catalog by id.')
    .option('--api-key <key>', 'API key for the provider. Falls back to KIMI_REGISTRY_API_KEY.')
    .option('--default-model <modelId>', 'Mark the imported model as default_model after import.')
    .option('--url <url>', `Override catalog URL. Defaults to ${DEFAULT_CATALOG_URL}.`)
    .action(
      async (
        providerId: string,
        options: { apiKey?: string; defaultModel?: string; url?: string },
      ) => {
        const resolved = resolveDeps(deps);
        await handleCatalogAdd(resolved, providerId, {
          ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
          ...(options.defaultModel === undefined ? {} : { defaultModel: options.defaultModel }),
          ...(options.url === undefined ? {} : { url: options.url }),
        });
      },
    );
}

function resolveDeps(overrides: Partial<ProviderDeps> = {}): ProviderDeps {
  let harness: KimiHarness | undefined;
  const identity = createKimiCodeHostIdentity();
  return {
    getHarness:
      overrides.getHarness ??
      (() => {
        harness ??= createKimiHarness({ identity });
        return harness;
      }),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    env: overrides.env ?? process.env,
    exit: overrides.exit ?? ((code: number) => process.exit(code)),
  };
}

function resolveApiKey(flag: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof flag === 'string' && flag.length > 0) return flag;
  const fromEnv = env['KIMI_REGISTRY_API_KEY'];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return undefined;
}

function asManaged(config: KimiConfig): ManagedKimiConfigShape {
  return config as unknown as ManagedKimiConfigShape;
}

function providerSourceLabel(provider: KimiConfig['providers'][string]): string {
  const source = provider.source;
  if (source !== undefined) {
    if (source['kind'] === 'apiJson' && typeof source['url'] === 'string') {
      return `apiJson(${source['url']})`;
    }
  }
  if (provider.oauth !== undefined) return 'oauth';
  return 'inline';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
