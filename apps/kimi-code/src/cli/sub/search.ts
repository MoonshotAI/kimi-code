/**
 * `kimi search` sub-command — non-interactive web search backend management.
 *
 * Mirrors the TUI `/settings` → Web Search flow
 * (apps/kimi-code/src/tui/commands/web-search.ts) for users who want to
 * inspect or change the LangSearch / rerank configuration without launching
 * the TUI.
 *
 * - `status`              Show the active web search backend and rerank status.
 * - `set langsearch`      Write a `[services.langsearch]` section.
 * - `clear langsearch`    Remove the `[services.langsearch]` section.
 * - `set rerank`          Write a `[services.rerank]` section.
 * - `clear rerank`        Remove the `[services.rerank]` section.
 * - `limits`             Print the LangSearch tier rate-limit table.
 */

import {
  createKimiHarness,
  type KimiConfig,
  type KimiHarness,
} from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';

import { createKimiCodeHostIdentity } from '#/cli/version';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface SearchDeps {
  readonly getHarness: () => KimiHarness;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
}

interface SetLangSearchOptions {
  readonly apiKey?: string;
  readonly tier?: string;
  readonly count?: string;
}

interface SetRerankOptions {
  readonly provider?: string;
  readonly apiKey?: string;
  readonly enabled?: string;
}

const LANGSEARCH_TIERS = ['free', 'tier1', 'tier2', 'tier3'] as const;
type LangSearchTier = (typeof LANGSEARCH_TIERS)[number];

const RERANK_PROVIDERS = ['langsearch'] as const;
type RerankProvider = (typeof RERANK_PROVIDERS)[number];

const LANGSEARCH_EXPERIMENTAL_FLAG = 'langsearch-web-search';
const LANGSEARCH_EXPERIMENTAL_MESSAGE =
  'LangSearch web search is experimental. Enable it in Settings → Experiments or set [experimental].langsearch-web-search = true.\n';

interface TierLimit {
  readonly qps: number;
  readonly qpm: number;
  readonly qpd: number;
}

// Rate limits reflect LangSearch's published per-tier quotas.
const TIER_LIMITS: Record<LangSearchTier, TierLimit> = {
  free: { qps: 1, qpm: 60, qpd: 1_000 },
  tier1: { qps: 5, qpm: 200, qpd: 2_000 },
  tier2: { qps: 10, qpm: 500, qpd: 10_000 },
  tier3: { qps: 30, qpm: 2_000, qpd: 100_000 },
};

function isLangSearchTier(value: string): value is LangSearchTier {
  return (LANGSEARCH_TIERS as readonly string[]).includes(value);
}

function isRerankProvider(value: string): value is RerankProvider {
  return (RERANK_PROVIDERS as readonly string[]).includes(value);
}

export async function handleSearchStatus(deps: SearchDeps): Promise<void> {
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const [config, features] = await Promise.all([
    harness.getConfig(),
    harness.getExperimentalFeatures(),
  ]);
  const services = config.services ?? {};
  const langSearchEnabled = isExperimentalEnabled(features);
  const backend = activeBackend(services, langSearchEnabled);
  deps.stdout.write(`Web search backend: ${backend}\n`);
  const langsearch = services.langsearch;
  if (hasValue(langsearch?.apiKey)) {
    deps.stdout.write(
      `LangSearch: tier=${langsearch?.tier ?? 'free'}  count=${String(langsearch?.count ?? 10)}${langSearchEnabled ? '' : '  status=experimental feature disabled'}\n`,
    );
  }
  const rerank = services.rerank;
  if (rerank?.provider !== undefined) {
    const hasApiKey = hasValue(rerank.apiKey) || hasValue(services.langsearch?.apiKey);
    const status = !langSearchEnabled
      ? 'experimental feature disabled'
      : rerank.enabled === false
        ? 'disabled'
        : hasApiKey
          ? 'enabled'
          : 'missing API key';
    deps.stdout.write(`Rerank: ${status} (provider: ${rerank.provider})\n`);
  } else {
    deps.stdout.write('Rerank: not configured\n');
  }
}

export async function handleSearchSetLangSearch(
  deps: SearchDeps,
  opts: SetLangSearchOptions,
): Promise<void> {
  const apiKey = opts.apiKey;
  if (apiKey === undefined || apiKey.length === 0) {
    deps.stderr.write('Missing API key. Pass --api-key <key>.\n');
    deps.exit(1);
  }

  const tier = opts.tier ?? 'free';
  if (!isLangSearchTier(tier)) {
    deps.stderr.write(
      `Invalid tier "${opts.tier}". Expected one of: ${LANGSEARCH_TIERS.join(', ')}.\n`,
    );
    deps.exit(1);
  }

  const count = opts.count === undefined ? 10 : parseCount(opts.count, deps);
  if (count === undefined) return;

  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  await requireLangSearchExperimental(harness, deps);

  await harness.replaceService('langsearch', { apiKey, tier, count });

  deps.stdout.write(
    `LangSearch configured: tier=${tier}  count=${String(count)}\n`,
  );
}

export async function handleSearchSetRerank(
  deps: SearchDeps,
  opts: SetRerankOptions,
): Promise<void> {
  const provider = opts.provider ?? 'langsearch';
  if (!isRerankProvider(provider)) {
    deps.stderr.write(
      `Unknown rerank provider "${opts.provider}". Only "langsearch" is supported.\n`,
    );
    deps.exit(1);
  }

  const enabled = opts.enabled === undefined ? true : parseBool(opts.enabled, deps, '--enabled');
  if (enabled === undefined) return;

  const apiKey = opts.apiKey;

  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  await requireLangSearchExperimental(harness, deps);
  const config = await harness.getConfig();
  if (enabled && !hasValue(apiKey) && !hasValue(config.services?.langsearch?.apiKey)) {
    deps.stderr.write(
      'Missing API key. Pass --api-key <key> or configure LangSearch web search first.\n',
    );
    deps.exit(1);
  }

  await harness.replaceService('rerank', {
    enabled,
    provider,
    apiKey: hasValue(apiKey) ? apiKey : undefined,
  });

  deps.stdout.write(
    `Rerank configured: provider=${provider}  enabled=${String(enabled)}${apiKey && apiKey.length > 0 ? '  api_key=set' : '  api_key=reuse-langsearch'}\n`,
  );
}

export async function handleSearchClear(
  deps: SearchDeps,
  provider: string,
): Promise<void> {
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await harness.getConfig();
  const services = config.services ?? {};

  if (provider === 'langsearch') {
    if (services.langsearch === undefined) {
      deps.stdout.write('LangSearch is not configured.\n');
      return;
    }
    await harness.removeService('langsearch');
    deps.stdout.write('LangSearch web search cleared.\n');
    return;
  }

  if (provider === 'rerank') {
    if (services.rerank === undefined) {
      deps.stdout.write('Rerank is not configured.\n');
      return;
    }
    await harness.removeService('rerank');
    deps.stdout.write('Rerank configuration cleared.\n');
    return;
  }

  deps.stderr.write(
    `Unknown provider "${provider}". Use "langsearch" or "rerank".\n`,
  );
  deps.exit(1);
}

export function handleSearchLimits(deps: SearchDeps): void {
  deps.stdout.write('LangSearch tier rate limits:\n\n');
  deps.stdout.write('  tier    qps   qpm     qpd\n');
  for (const tier of LANGSEARCH_TIERS) {
    const limit = TIER_LIMITS[tier];
    deps.stdout.write(
      `  ${tier.padEnd(7)} ${String(limit.qps).padStart(3)}   ${String(limit.qpm).padStart(5)}   ${String(limit.qpd).padStart(6)}\n`,
    );
  }
}

function activeBackend(
  services: NonNullable<KimiConfig['services']>,
  langSearchEnabled: boolean,
): string {
  if (langSearchEnabled && hasValue(services.langsearch?.apiKey)) return 'LangSearch';
  if (hasValue(services.moonshotSearch?.baseUrl)) return 'Moonshot';
  if (hasValue(services.langsearch?.apiKey)) {
    return 'not configured (LangSearch experimental feature disabled)';
  }
  return 'not configured';
}

function isExperimentalEnabled(
  features: Awaited<ReturnType<KimiHarness['getExperimentalFeatures']>>,
): boolean {
  return features.some(
    (feature) => feature.id === LANGSEARCH_EXPERIMENTAL_FLAG && feature.enabled,
  );
}

async function requireLangSearchExperimental(
  harness: KimiHarness,
  deps: SearchDeps,
): Promise<void> {
  if (isExperimentalEnabled(await harness.getExperimentalFeatures())) return;
  deps.stderr.write(LANGSEARCH_EXPERIMENTAL_MESSAGE);
  deps.exit(1);
}

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function parseCount(value: string, deps: SearchDeps): number | undefined {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    deps.stderr.write(`Invalid --count "${value}". Expected an integer between 1 and 10.\n`);
    deps.exit(1);
  }
  return n;
}

function parseBool(
  value: string,
  deps: SearchDeps,
  flag: string,
): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  deps.stderr.write(`Invalid ${flag} "${value}". Expected "true" or "false".\n`);
  deps.exit(1);
}

export function registerSearchCommand(parent: Command, deps?: Partial<SearchDeps>): void {
  const search = parent
    .command('search')
    .description('Manage the web search backend and rerank (LangSearch) non-interactively.');

  const runAction = async (resolved: SearchDeps, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      resolved.stderr.write(`${errorMessage(error)}\n`);
      resolved.exit(1);
    }
  };

  search
    .command('status')
    .description('Show the active web search backend and rerank status.')
    .action(async () => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () => handleSearchStatus(resolved));
    });

  const setCmd = search
    .command('set')
    .description('Configure a web search provider or rerank.');

  setCmd
    .command('langsearch')
    .description('Configure the LangSearch web search backend.')
    .requiredOption('--api-key <key>', 'API key for the provider.')
    .option('--tier <tier>', 'LangSearch tier: free | tier1 | tier2 | tier3.', 'free')
    .option('--count <n>', 'Number of results to request (1–10).', '10')
    .action(async (options: SetLangSearchOptions) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () => handleSearchSetLangSearch(resolved, options));
    });

  setCmd
    .command('rerank')
    .description('Configure the rerank provider.')
    .option('--provider <name>', 'Rerank provider: langsearch.', 'langsearch')
    .option('--api-key <key>', 'API key for rerank. Omit to reuse the LangSearch search key.')
    .option('--enabled <bool>', 'Enable rerank: true | false.', 'true')
    .action(async (options: SetRerankOptions) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () => handleSearchSetRerank(resolved, options));
    });

  search
    .command('clear <provider>')
    .description('Remove a web search provider or rerank config. Use "langsearch" or "rerank".')
    .action(async (provider: string) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () => handleSearchClear(resolved, provider));
    });

  search
    .command('limits')
    .description('Show the LangSearch tier rate-limit table.')
    .action(() => {
      const resolved = resolveDeps(deps);
      handleSearchLimits(resolved);
    });
}

function resolveDeps(overrides: Partial<SearchDeps> = {}): SearchDeps {
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
    exit: overrides.exit ?? ((code: number) => process.exit(code)),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}