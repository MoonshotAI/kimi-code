import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKimiConfigRpc, createKimiHarness, KimiError } from '#/index';

import {
  parseConfigString,
  readConfigFile,
  writeConfigFile,
} from '../../agent-core/src/config';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-config-'));
  tempDirs.push(dir);
  return dir;
}

const COMPLETE_TOML = `
default_model = "kimi-for-coding"
default_thinking = false
default_permission_mode = "auto"
skip_afk_prompt_injection = false
default_plan_mode = false
default_editor = ""
theme = "dark"
show_thinking_stream = true
merge_all_available_skills = true
extra_skill_dirs = ["~/team-skills", ".agents/team-skills"]

[providers.kimi-for-coding]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = "sk-xxx"
custom_headers = { "X-Custom-Header" = "value" }

[providers.kimi-for-coding.env]
GOOGLE_CLOUD_PROJECT = "project-1"

[models.kimi-for-coding]
provider = "kimi-for-coding"
model = "kimi-for-coding"
max_context_size = 262144
capabilities = ["image_in", "thinking", "video_in"]
display_name = "Kimi for Coding"

[loop_control]
max_retries_per_step = 3
max_ralph_iterations = 0
reserved_context_size = 50000
compaction_trigger_ratio = 0.85

[background]
max_running_tasks = 4
keep_alive_on_exit = false
kill_grace_period_ms = 2000
print_wait_ceiling_s = 3600

[services.moonshot_search]
base_url = "https://api.kimi.com/coding/v1/search"
api_key = "sk-search"
custom_headers = { "X-Search" = "1" }

[services.moonshot_fetch]
base_url = "https://api.kimi.com/coding/v1/fetch"
api_key = "sk-fetch"

[notifications]
claim_stale_after_ms = 15000
`;

describe('SDK config TOML', () => {
  it('resolves config paths through the config RPC wrapper', async () => {
    const dir = await makeTempDir();
    const rpc = createKimiConfigRpc();

    await expect(rpc.resolveConfigPath({ homeDir: dir })).resolves.toBe(join(dir, 'config.toml'));
  });

  it('returns structured validation issues through the config RPC wrapper', async () => {
    const rpc = createKimiConfigRpc();

    await expect(
      rpc.validateConfigToml({
        text: `
[providers.kimi]
type = "kimi"

[models.kimi]
provider = "kimi"
model = "kimi"
max_context_size = "large"
`,
        filePath: 'broken.toml',
      }),
    ).rejects.toMatchObject({
      details: {
        validationIssues: [
          {
            path: ['models', 'kimi', 'maxContextSize'],
          },
        ],
      },
    });
  });

  it('parses the documented config shape and keeps TUI-only fields in raw', () => {
    const config = parseConfigString(COMPLETE_TOML, 'complete.toml');

    expect(config.defaultModel).toBe('kimi-for-coding');
    expect(config.defaultThinking).toBe(false);
    expect(config.defaultPermissionMode).toBe('auto');
    expect(config.defaultPlanMode).toBe(false);
    expect(config.mergeAllAvailableSkills).toBe(true);
    expect(config.extraSkillDirs).toEqual(['~/team-skills', '.agents/team-skills']);

    const provider = config.providers['kimi-for-coding'];
    expect(provider).toMatchObject({
      type: 'kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-xxx',
      customHeaders: { 'X-Custom-Header': 'value' },
      env: { GOOGLE_CLOUD_PROJECT: 'project-1' },
    });

    expect(config.models?.['kimi-for-coding']).toMatchObject({
      provider: 'kimi-for-coding',
      model: 'kimi-for-coding',
      maxContextSize: 262144,
      capabilities: ['image_in', 'thinking', 'video_in'],
      displayName: 'Kimi for Coding',
    });

    expect(config.loopControl).toEqual({
      maxRetriesPerStep: 3,
      maxRalphIterations: 0,
      reservedContextSize: 50000,
      compactionTriggerRatio: 0.85,
    });
    expect(config.background).toEqual({
      maxRunningTasks: 4,
      keepAliveOnExit: false,
      killGracePeriodMs: 2000,
      printWaitCeilingS: 3600,
    });
    expect(config.services?.moonshotSearch?.customHeaders).toEqual({ 'X-Search': '1' });
    expect(config.services?.moonshotFetch?.apiKey).toBe('sk-fetch');

    expect('theme' in config).toBe(false);
    expect(config.raw?.['theme']).toBe('dark');
    expect(config.raw?.['skip_afk_prompt_injection']).toBe(false);
    expect(config.raw?.['show_thinking_stream']).toBe(true);
    expect(config.raw?.['notifications']).toEqual({ claim_stale_after_ms: 15000 });
  });

  it('writes typed fields in snake_case and preserves unknown raw sections', async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, 'config.toml');
    const config = parseConfigString(COMPLETE_TOML, configPath);

    await writeConfigFile(configPath, {
      ...config,
      defaultModel: 'kimi-for-coding',
      loopControl: {
        ...config.loopControl,
        maxStepsPerTurn: 42,
      },
    });

    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('default_model = "kimi-for-coding"');
    expect(text).toContain('default_permission_mode = "auto"');
    expect(text).toContain('extra_skill_dirs = [ "~/team-skills", ".agents/team-skills" ]');
    expect(text).not.toContain('default_yolo');
    expect(text).toContain('max_steps_per_turn = 42');
    expect(text).toContain('display_name = "Kimi for Coding"');
    expect(text).toContain('GOOGLE_CLOUD_PROJECT = "project-1"');
    expect(text).toContain('claim_stale_after_ms = 15000');
    expect(text).toContain('theme = "dark"');

    const reloaded = readConfigFile(configPath);
    expect(reloaded.loopControl?.maxStepsPerTurn).toBe(42);
    expect(reloaded.raw?.['theme']).toBe('dark');
  });

  it('accepts camelCase aliases without keeping unknown fields in typed config', () => {
    const config = parseConfigString(`
defaultModel = "camel-model"

[providers.local]
type = "openai"
baseUrl = "https://example.test/v1"
apiKey = "sk-test"
unsupported_provider_field = "raw-only"

[models.camel-model]
provider = "local"
model = "gpt-test"
maxContextSize = 128000
displayName = "Camel Model"
custom_model_field = "raw-only"

[services.moonshotSearch]
baseUrl = "https://example.test/search"
apiKey = "sk-search"

[loopControl]
maxStepsPerRun = 7

[background]
maxRunningTasks = 2
`);

    expect(config.defaultModel).toBe('camel-model');
    expect(config.providers['local']).toMatchObject({
      type: 'openai',
      baseUrl: 'https://example.test/v1',
      apiKey: 'sk-test',
    });
    expect(config.models?.['camel-model']).toMatchObject({
      maxContextSize: 128000,
      displayName: 'Camel Model',
    });
    expect(config.services?.moonshotSearch).toMatchObject({
      baseUrl: 'https://example.test/search',
      apiKey: 'sk-search',
    });
    expect(config.loopControl?.maxStepsPerTurn).toBe(7);
    expect(config.background?.maxRunningTasks).toBe(2);

    expect('unsupportedProviderField' in config.providers['local']!).toBe(false);
    expect('customModelField' in config.models!['camel-model']!).toBe(false);

    const rawProviders = config.raw?.['providers'] as Record<string, Record<string, unknown>>;
    const rawModels = config.raw?.['models'] as Record<string, Record<string, unknown>>;
    expect(rawProviders['local']?.['unsupported_provider_field']).toBe('raw-only');
    expect(rawModels['camel-model']?.['custom_model_field']).toBe('raw-only');
  });
});

describe('KimiHarness config API', () => {
  it('loads default config when missing and deep-merges setConfig patches from disk', async () => {
    const homeDir = await makeTempDir();
    const configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, COMPLETE_TOML, 'utf-8');

    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await harness.setConfig({
      providers: {
        'kimi-for-coding': {
          apiKey: 'sk-updated',
        },
      },
      services: {
        moonshotSearch: {
          apiKey: 'sk-search-updated',
        },
      },
    });

    const config = await harness.getConfig({ reload: true });
    expect(config.providers['kimi-for-coding']).toMatchObject({
      type: 'kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-updated',
      env: { GOOGLE_CLOUD_PROJECT: 'project-1' },
    });
    expect(config.services?.moonshotSearch?.apiKey).toBe('sk-search-updated');
    expect(config.raw?.['theme']).toBe('dark');

    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('theme = "dark"');
    expect(text).toContain('GOOGLE_CLOUD_PROJECT = "project-1"');
    expect(text).toContain('claim_stale_after_ms = 15000');
  });

  it('does not write invalid config patches', async () => {
    const homeDir = await makeTempDir();
    const configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, COMPLETE_TOML, 'utf-8');
    const before = await readFile(configPath, 'utf-8');

    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    const setInvalidConfig = harness.setConfig({
      providers: {
        bad: {
          type: 'not-a-provider',
        },
      },
    } as never);

    await expect(setInvalidConfig).rejects.toBeInstanceOf(KimiError);
    await expect(setInvalidConfig).rejects.toMatchObject({
      code: 'config.invalid',
    } satisfies Partial<KimiError>);

    await expect(readFile(configPath, 'utf-8')).resolves.toBe(before);
  });

  it('uses default config when the config file is absent', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.getConfig()).resolves.toEqual({ providers: {} });
  });

  it('returns experimental feature metadata through the harness', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION', '');
    const homeDir = await makeTempDir();
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[experimental]
micro_compaction = false
`,
      'utf-8',
    );
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    const features = await harness.getExperimentalFeatures();
    const microCompaction = features.find((feature) => feature.id === 'micro_compaction');

    expect(microCompaction).toMatchObject({
      id: 'micro_compaction',
      title: 'Micro compaction',
      enabled: false,
      source: 'config',
      configValue: false,
      env: 'KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION',
    });
    expect(features).toEqual([
      expect.objectContaining({ id: 'micro_compaction', enabled: false }),
    ]);
  });

  it('can create the default config scaffold without selecting a model', async () => {
    const homeDir = await makeTempDir();
    const configPath = join(homeDir, 'config.toml');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await harness.ensureConfigFile();

    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('Runtime settings for Kimi Code.');
    expect(text).not.toMatch(/^default_thinking =/m);
    expect(text).not.toMatch(/^default_model =/m);

    const config = await harness.getConfig({ reload: true });
    expect(config.providers).toEqual({});
    expect(config.defaultModel).toBeUndefined();
    expect(config.defaultThinking).toBeUndefined();
  });

  it('reloads an active session without closing the SDK session wrapper', async () => {
    const homeDir = await makeTempDir();
    const workDir = join(homeDir, 'work');
    const configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, COMPLETE_TOML, 'utf-8');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    const session = await harness.createSession({
      id: 'session-sdk-reload',
      workDir,
      model: 'kimi-for-coding',
    });

    expect(session.getResumeState()).toBeUndefined();

    const reloaded = await harness.reloadSession({ id: session.id });

    expect(reloaded).toBe(session);
    expect(harness.getSession(session.id)).toBe(session);
    expect(session.getResumeState()?.agents['main']).toBeDefined();
    await expect(session.getStatus()).resolves.toMatchObject({ model: 'kimi-for-coding' });
  });

  it('forwards forcePluginSessionStartReminder to the active session reload', async () => {
    const homeDir = await makeTempDir();
    const workDir = join(homeDir, 'work');
    const configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, COMPLETE_TOML, 'utf-8');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    const session = await harness.createSession({
      id: 'session-sdk-reload-forward',
      workDir,
      model: 'kimi-for-coding',
    });

    const reloadSpy = vi.spyOn(session, 'reloadSession').mockResolvedValue({} as never);

    await harness.reloadSession({ id: session.id, forcePluginSessionStartReminder: true });

    expect(reloadSpy).toHaveBeenCalledWith({ forcePluginSessionStartReminder: true });
  });
});
