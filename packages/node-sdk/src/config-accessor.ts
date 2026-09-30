import { existsSync, readFileSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  createConfigStore,
  defaultModelConfigSection,
  describeTomlSyntaxError,
  describeUnknownError,
  modelsConfigSection,
  parseConfigText,
  providersConfigSection,
  thinkingConfigSection,
  transformTomlData,
  isPlainObject,
  type ConfigSectionContribution,
  type ConfigStore,
  type ConfigTomlHooks,
} from '@moonshot-ai/agent-core';
import { servicesConfigSection } from '@moonshot-ai/harness-core';
import type { ManagedKimiConfigShape } from '@moonshot-ai/kimi-code-oauth';

import { createTomlConfigPersist } from '#/config-persist';
import { ErrorCodes, KimiError } from '#/errors';

export type KimiAuthConfig = ManagedKimiConfigShape;

export type KimiAuthConfigStoreView = Pick<ConfigStore, 'get' | 'replace' | 'reload' | 'diagnostics'>;

export interface KimiAuthConfigAccessor {
  read(): Promise<KimiAuthConfig>;
  write(config: KimiAuthConfig): Promise<void>;
}

const AUTH_CONFIG_SECTIONS: readonly ConfigSectionContribution[] = [
  providersConfigSection as ConfigSectionContribution,
  modelsConfigSection as ConfigSectionContribution,
  thinkingConfigSection as ConfigSectionContribution,
  defaultModelConfigSection as ConfigSectionContribution,
  servicesConfigSection as ConfigSectionContribution,
];

const authSectionLookup = (name: string): ConfigTomlHooks | undefined =>
  AUTH_CONFIG_SECTIONS.find((section) => section.name === name);

export function createKimiConfigStore(configPath: string): ConfigStore {
  const store = createConfigStore({
    persist: createTomlConfigPersist(configPath),
    env: process.env,
  });
  store.syncSections([...AUTH_CONFIG_SECTIONS]);
  return store;
}

export function createKimiAuthConfigAccessor(
  config: KimiAuthConfigStoreView,
  configPath: string,
): KimiAuthConfigAccessor {
  return {
    read: async () => {
      await config.reload();
      return structuredClone({
        providers: config.get<KimiAuthConfig['providers']>('providers') ?? {},
        models: config.get<KimiAuthConfig['models']>('models'),
        defaultModel: config.get<string | undefined>('defaultModel'),
        defaultProvider: config.get<string | undefined>('defaultProvider'),
        thinking: config.get<KimiAuthConfig['thinking']>('thinking'),
        services: servicesToManaged(config.get('services')),
      });
    },
    write: async (next) => {
      await config.reload();
      const failure = config.diagnostics().find((entry) => entry.severity === 'error');
      if (failure !== undefined) {
        throw new KimiError(
          ErrorCodes.CONFIG_INVALID,
          `Cannot change settings while ${configPath} is invalid — fix it first (run \`kimi doctor\` for details).`,
        );
      }
      await config.replace(
        {
          providers: next.providers,
          models: modelsToMemory(next.models),
          defaultModel: next.defaultModel,
          defaultProvider: next['defaultProvider'],
          thinking: next.thinking,
          services: servicesToMemory(next.services),
        },
        'user',
      );
    },
  };
}

export function createStandaloneKimiAuthConfigAccessor(configPath: string): KimiAuthConfigAccessor {
  return createKimiAuthConfigAccessor(createKimiConfigStore(configPath), configPath);
}

export interface KimiConfigSnapshot {
  readonly sections: Record<string, unknown>;
  readonly error?: string;
}

export function readKimiConfigSnapshot(configPath: string): KimiConfigSnapshot {
  let text: string | undefined;
  try {
    text = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : undefined;
  } catch (error) {
    return { sections: {}, error: `Failed to read ${configPath}: ${describeUnknownError(error)}` };
  }
  if (text === undefined || text.trim().length === 0) return { sections: {} };
  try {
    return { sections: transformTomlData(parseConfigText(text), authSectionLookup) };
  } catch (error) {
    return { sections: {}, error: `Invalid TOML in ${configPath}: ${describeTomlSyntaxError(error)}` };
  }
}

const DEFAULT_CONFIG_FILE_TEXT = `# ~/.kimi-code/config.toml
# Runtime settings for Kimi Code.
# This file starts empty so built-in defaults can apply.
# Login will populate managed Kimi provider and model entries.
`;

export async function ensureConfigFile(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, 'wx', 0o600);
    await handle.writeFile(DEFAULT_CONFIG_FILE_TEXT, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  } finally {
    await handle?.close();
  }
}

function servicesToManaged(value: unknown): KimiAuthConfig['services'] {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'moonshot_search') out['moonshotSearch'] = entry;
    else if (key === 'moonshot_fetch') out['moonshotFetch'] = entry;
    else out[key] = entry;
  }
  return out as KimiAuthConfig['services'];
}

function servicesToMemory(services: KimiAuthConfig['services']): Record<string, unknown> | undefined {
  if (services === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(services)) {
    if (key === 'moonshotSearch') out['moonshot_search'] = entry;
    else if (key === 'moonshotFetch') out['moonshot_fetch'] = entry;
    else out[key] = entry;
  }
  return out;
}

function modelsToMemory(models: KimiAuthConfig['models']): unknown {
  if (models === undefined) return undefined;
  return modelsConfigSection.fromToml?.(models) ?? models;
}
