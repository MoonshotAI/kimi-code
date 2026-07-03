import { mkdtempSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import { ErrorCodes, KimiError } from '../../src/errors';
import {
  KimiConfigSchema,
  configToTomlData,
  ensureConfigFile,
  loadRuntimeConfig,
  loadRuntimeConfigSafe,
  mergeConfigPatch,
  parseConfigString,
  parseBooleanEnv,
  readConfigFile,
  readConfigFileForUpdate,
  resolveConfigPath,
  resolveConfigValue,
  resolveKimiHome,
  validateConfig,
  writeConfigFile,
} from '../../src/config';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-core-config-'));
  tempDirs.push(dir);
  return dir;
}

function expectKimiErrorCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(KimiError);
    expect((error as KimiError).code).toBe(code);
    return;
  }
  throw new Error('expected function to throw');
}

const COMPLETE_TOML = `
default_model = "kimi-code/kimi-for-coding"
default_permission_mode = "auto"
default_plan_mode = false
merge_all_available_skills = true
extra_skill_dirs = ["~/team-skills", ".agents/team-skills"]
telemetry = false
theme = "dark"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = "sk-file"
custom_headers = { "X-Test" = "1" }

[providers."managed:kimi-code".env]
GOOGLE_CLOUD_PROJECT = "project-1"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144
capabilities = ["image_in", "thinking", "video_in"]
display_name = "Kimi for Coding"

[thinking]
enabled = true
effort = "medium"

[permission]
mode = "manual"

[[permission.rules]]
decision = "deny"
scope = "user"
pattern = "Bash(rm *)"
reason = "no rm"

[[permission.allow]]
tool = "Read"
match = "src/**"
reason = "read src"

[loop_control]
max_steps_per_run = 42
max_retries_per_step = 3
reserved_context_size = 50000
compaction_trigger_ratio = 0.85

[background]
max_running_tasks = 4
keep_alive_on_exit = false
kill_grace_period_ms = 2000
print_wait_ceiling_s = 3600

[[hooks]]
event = "PreToolUse"
matcher = "Shell"
command = "echo pre"
timeout = 5

[[hooks]]
event = "Stop"
command = "echo stop"

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

describe('harness config TOML loader', () => {
  it('parses the current config.toml shape through explicit field mappings', () => {
    const config = parseConfigString(COMPLETE_TOML, 'config.toml');

    expect(config.defaultModel).toBe('kimi-code/kimi-for-coding');
    expect(config.thinking?.enabled).toBe(true);
    expect(config.defaultPermissionMode).toBe('auto');
    expect(config.defaultPlanMode).toBe(false);
    expect(config.mergeAllAvailableSkills).toBe(true);
    expect(config.extraSkillDirs).toEqual(['~/team-skills', '.agents/team-skills']);
    expect(config.telemetry).toBe(false);
    expect(config.providers['managed:kimi-code']).toMatchObject({
      type: 'kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-file',
      env: { GOOGLE_CLOUD_PROJECT: 'project-1' },
      customHeaders: { 'X-Test': '1' },
    });
    expect(config.models?.['kimi-code/kimi-for-coding']).toMatchObject({
      provider: 'managed:kimi-code',
      model: 'kimi-for-coding',
      maxContextSize: 262144,
      capabilities: ['image_in', 'thinking', 'video_in'],
      displayName: 'Kimi for Coding',
    });
    expect(config.thinking).toEqual({ enabled: true, effort: 'medium' });
    expect(config.permission).toEqual({
      rules: [
        {
          decision: 'deny',
          scope: 'user',
          pattern: 'Bash(rm *)',
          reason: 'no rm',
        },
        {
          decision: 'allow',
          scope: 'user',
          pattern: 'Read(src/**)',
          reason: 'read src',
        },
      ],
    });
    expect(config.loopControl).toMatchObject({
      maxStepsPerTurn: 42,
      maxRetriesPerStep: 3,
      reservedContextSize: 50000,
      compactionTriggerRatio: 0.85,
    });
    expect(config.background).toMatchObject({
      maxRunningTasks: 4,
      keepAliveOnExit: false,
      killGracePeriodMs: 2000,
      printWaitCeilingS: 3600,
    });
    expect(config.hooks).toEqual([
      {
        event: 'PreToolUse',
        matcher: 'Shell',
        command: 'echo pre',
        timeout: 5,
      },
      {
        event: 'Stop',
        command: 'echo stop',
      },
    ]);
    expect(config.services?.moonshotSearch?.customHeaders).toEqual({ 'X-Search': '1' });
    expect(config.services?.moonshotFetch?.apiKey).toBe('sk-fetch');

    expect('theme' in config).toBe(false);
    expect(config.raw?.['theme']).toBe('dark');
    expect(config.raw?.['notifications']).toEqual({ claim_stale_after_ms: 15000 });
  });

  it('round-trips a custom registry source field on a provider', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'round-trip.toml');
    const toml = `
[providers.custom]
type = "openai"
base_url = "https://custom.example/v1"
api_key = "sk-test"
source = { kind = "apiJson", url = "https://registry.example/api.json", apiKey = "sk-registry" }
`;
    const config = parseConfigString(toml, configPath);
    expect(config.providers['custom']).toMatchObject({
      type: 'openai',
      baseUrl: 'https://custom.example/v1',
      apiKey: 'sk-test',
      source: { kind: 'apiJson', url: 'https://registry.example/api.json', apiKey: 'sk-registry' },
    });

    await writeConfigFile(configPath, config);
    const text = await readFile(configPath, 'utf-8');
    const roundTripped = parseConfigString(text, configPath);
    expect(roundTripped.providers['custom']?.source).toEqual({
      kind: 'apiJson',
      url: 'https://registry.example/api.json',
      apiKey: 'sk-registry',
    });
  });

  it('round-trips OAuth refs with scoped OAuth hosts', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'oauth-ref.toml');
    const toml = `
[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.dev.example.test/coding/v1"
api_key = ""
oauth = { storage = "file", key = "oauth/kimi-code-env-1234", oauth_host = "https://auth.dev.example.test" }

[services.moonshot_search]
base_url = "https://api.dev.example.test/coding/v1/search"
api_key = ""
oauth = { storage = "file", key = "oauth/kimi-code-env-1234", oauth_host = "https://auth.dev.example.test" }
`;
    const config = parseConfigString(toml, configPath);
    expect(config.providers['managed:kimi-code']?.oauth).toEqual({
      storage: 'file',
      key: 'oauth/kimi-code-env-1234',
      oauthHost: 'https://auth.dev.example.test',
    });
    expect(config.services?.moonshotSearch?.oauth?.oauthHost).toBe('https://auth.dev.example.test');

    await writeConfigFile(configPath, config);
    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('oauth_host = "https://auth.dev.example.test"');
    const roundTripped = parseConfigString(text, configPath);
    expect(roundTripped.providers['managed:kimi-code']?.oauth?.oauthHost).toBe(
      'https://auth.dev.example.test',
    );
  });

  it('parses and round-trips experimental feature flags', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'experimental.toml');
    const toml = `
[experimental]
micro_compaction = false
`;
    const config = parseConfigString(toml, configPath);

    expect(config.experimental).toEqual({
      'micro_compaction': false,
    });

    await writeConfigFile(configPath, config);
    const text = await readFile(configPath, 'utf-8');

    expect(text).toContain('[experimental]');
    expect(text).toContain('micro_compaction = false');
    expect(parseConfigString(text, configPath).experimental).toEqual(config.experimental);
  });

  it('accepts obsolete experimental feature keys as inert config', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'obsolete-experimental.toml');
    const toml = `
[experimental]
legacy_feature = true
obsolete_feature = false
removed_flag = true
`;

    const config = parseConfigString(toml, configPath);

    expect(config.experimental).toEqual({
      'legacy_feature': true,
      'obsolete_feature': false,
      'removed_flag': true,
    });

    await writeConfigFile(configPath, config);
    const text = await readFile(configPath, 'utf-8');
    expect(parseConfigString(text, configPath).experimental).toEqual(config.experimental);
  });

  it('loads defaults for absent files and writes typed fields without dropping raw sections', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.toml');

    expect(readConfigFile(configPath)).toEqual({ providers: {} });

    const config = parseConfigString(COMPLETE_TOML, configPath);
    const loopControl = config.loopControl;
    expect(loopControl).toBeDefined();
    await writeConfigFile(configPath, {
      ...config,
      defaultModel: 'kimi-code/kimi-for-coding',
      loopControl: {
        ...loopControl!,
        maxStepsPerTurn: 7,
      },
    });

    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('default_model = "kimi-code/kimi-for-coding"');
    expect(text).toContain('default_permission_mode = "auto"');
    expect(text).toContain('extra_skill_dirs = [ "~/team-skills", ".agents/team-skills" ]');
    expect(text).toContain('telemetry = false');
    expect(text).not.toContain('default_yolo');
    expect(text).toContain('[[permission.rules]]');
    expect(text).toContain('pattern = "Bash(rm *)"');
    expect(text).toContain('pattern = "Read(src/**)"');
    expect(text).not.toContain('[[permission.allow]]');
    expect(text).toContain('max_steps_per_turn = 7');
    expect(text).toContain('GOOGLE_CLOUD_PROJECT = "project-1"');
    expect(text).toContain('theme = "dark"');
    expect(text).toContain('claim_stale_after_ms = 15000');
    expect(text).toContain('[[hooks]]');
    expect(text).toContain('event = "PreToolUse"');
    expect(text).toContain('command = "echo pre"');

    const reloaded = readConfigFile(configPath);
    expect(reloaded.loopControl?.maxStepsPerTurn).toBe(7);
    expect(reloaded.hooks?.[0]?.event).toBe('PreToolUse');
    expect(reloaded.raw?.['theme']).toBe('dark');
  });

  it('creates a parseable default config scaffold without changing runtime defaults', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.toml');

    await ensureConfigFile(configPath);

    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('Runtime settings for Kimi Code.');
    expect(text).not.toMatch(/^default_thinking =/m);
    expect(text).not.toMatch(/^default_model =/m);

    const config = readConfigFile(configPath);
    expect(config.providers).toEqual({});
    expect(config.defaultModel).toBeUndefined();
    expect(config.thinking?.enabled).toBeUndefined();
  });

  it('does not overwrite an existing config file', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.toml');
    const existing = 'default_model = "custom"\n';
    await writeFile(configPath, existing, 'utf-8');

    await ensureConfigFile(configPath);

    await expect(readFile(configPath, 'utf-8')).resolves.toBe(existing);
  });

  it('drops deprecated default_yolo when rewriting config files', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.toml');
    const config = parseConfigString('default_yolo = true\n', configPath);

    expect(config.defaultPermissionMode).toBeUndefined();

    await writeConfigFile(configPath, config);

    const text = await readFile(configPath, 'utf-8');
    expect(text).not.toContain('default_yolo');
    expect(text).not.toContain('default_permission_mode');
  });

  it('rejects invalid TOML and invalid schema with KimiError(config.invalid)', () => {
    expectKimiErrorCode(
      () => parseConfigString('[[[', 'broken.toml'),
      ErrorCodes.CONFIG_INVALID,
    );
    expectKimiErrorCode(
      () =>
        parseConfigString(
          `
[providers.bad]
type = "not-a-provider"
`,
          'broken.toml',
        ),
      ErrorCodes.CONFIG_INVALID,
    );
    expectKimiErrorCode(
      () =>
        parseConfigString(
          `
[[permission.rules]]
decision = "deny"
pattern = "Bash(rm *"
`,
          'broken.toml',
        ),
      ErrorCodes.CONFIG_INVALID,
    );
  });

  it('parses hooks config from TOML arrays of tables', () => {
    const config = parseConfigString(
      `
[[hooks]]
event = "PreToolUse"
matcher = "Shell"
command = "echo hi"
timeout = 5
`,
      'hooks.toml',
    );

    expect(config.hooks).toEqual([
      {
        event: 'PreToolUse',
        matcher: 'Shell',
        command: 'echo hi',
        timeout: 5,
      },
    ]);
  });

  it('rejects invalid hooks config', () => {
    expectKimiErrorCode(
      () =>
        parseConfigString(
          `
hooks = [{ type = "pre-tool-call", command = "echo hi" }]
`,
          'hooks.toml',
        ),
      ErrorCodes.CONFIG_INVALID,
    );
  });
});

describe('harness config schema and patch merge', () => {
  it('accepts the empty public config and requires model context size in full configs', () => {
    expect(KimiConfigSchema.parse({})).toEqual({ providers: {} });
    expect(() =>
      validateConfig({
        providers: {
          local: { type: 'openai', apiKey: 'sk-test' },
        },
        models: {
          broken: { provider: 'local', model: 'gpt-test' },
        },
      }),
    ).toThrow(/max_context_size/);
  });

  it('deep-merges validated patches while preserving existing typed and raw data', () => {
    const base = parseConfigString(COMPLETE_TOML);
    const merged = mergeConfigPatch(base, {
      providers: {
        'managed:kimi-code': {
          apiKey: 'sk-patched',
          baseUrl: undefined,
        },
      },
      models: {
        'kimi-code/kimi-for-coding': {
          capabilities: ['tool_use'],
        },
      },
      thinking: {
        effort: 'high',
      },
    });

    expect(merged.providers['managed:kimi-code']).toMatchObject({
      type: 'kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-patched',
      env: { GOOGLE_CLOUD_PROJECT: 'project-1' },
    });
    expect(merged.models?.['kimi-code/kimi-for-coding']).toMatchObject({
      provider: 'managed:kimi-code',
      model: 'kimi-for-coding',
      maxContextSize: 262144,
      capabilities: ['tool_use'],
    });
    expect(merged.thinking).toEqual({ enabled: true, effort: 'high' });
    expect(merged.hooks).toEqual(base.hooks);
    expect(merged.raw?.['theme']).toBe('dark');
  });

  it('deep-merges experimental config patches', () => {
    const base = parseConfigString(`
[experimental]
micro_compaction = false
`);

    const merged = mergeConfigPatch(base, {
      experimental: {
        'micro_compaction': true,
      },
    });

    expect(merged.experimental).toEqual({
      'micro_compaction': true,
    });
  });

  it('rejects unknown fields in config patches', () => {
    expectKimiErrorCode(
      () => mergeConfigPatch({ providers: {} }, { theme: 'dark' } as never),
      ErrorCodes.CONFIG_INVALID,
    );
  });

  it('replaces hooks arrays in config patches', () => {
    const base = parseConfigString(COMPLETE_TOML);
    const merged = mergeConfigPatch(base, {
      hooks: [{ event: 'Notification', matcher: 'task_completed', command: 'echo notified' }],
    });

    expect(merged.hooks).toEqual([
      { event: 'Notification', matcher: 'task_completed', command: 'echo notified' },
    ]);
  });

  it('accepts maxOutputSize on a model alias and round-trips it', () => {
    const parsed = KimiConfigSchema.parse({
      providers: { local: { type: 'anthropic', apiKey: 'sk-test' } },
      models: {
        opus: {
          provider: 'local',
          model: 'claude-opus-4-7',
          maxContextSize: 200000,
          maxOutputSize: 32000,
        },
      },
    });
    expect(parsed.models?.['opus']).toMatchObject({
      maxContextSize: 200000,
      maxOutputSize: 32000,
    });
  });

  it('leaves maxOutputSize undefined when omitted', () => {
    const parsed = KimiConfigSchema.parse({
      providers: { local: { type: 'anthropic', apiKey: 'sk-test' } },
      models: {
        opus: {
          provider: 'local',
          model: 'claude-opus-4-7',
          maxContextSize: 200000,
        },
      },
    });
    expect(parsed.models?.['opus']?.maxOutputSize).toBeUndefined();
  });

  it('rejects maxOutputSize <= 0', () => {
    expect(() =>
      KimiConfigSchema.parse({
        providers: { local: { type: 'anthropic', apiKey: 'sk-test' } },
        models: {
          opus: {
            provider: 'local',
            model: 'claude-opus-4-7',
            maxContextSize: 200000,
            maxOutputSize: 0,
          },
        },
      }),
    ).toThrow();
  });
});

describe('config path env override', () => {
  it('uses KIMI_CODE_HOME when no explicit homeDir is supplied', () => {
    const saved = process.env['KIMI_CODE_HOME'];
    try {
      process.env['KIMI_CODE_HOME'] = '/tmp/kimi-from-env';

      expect(resolveKimiHome()).toBe('/tmp/kimi-from-env');
      expect(resolveKimiHome('/tmp/kimi-explicit')).toBe('/tmp/kimi-explicit');
      expect(resolveConfigPath({})).toBe('/tmp/kimi-from-env/config.toml');
      expect(resolveConfigPath({ configPath: '/tmp/custom.toml' })).toBe('/tmp/custom.toml');
    } finally {
      if (saved === undefined) delete process.env['KIMI_CODE_HOME'];
      else process.env['KIMI_CODE_HOME'] = saved;
    }
  });
});

describe('config value env override helpers', () => {
  it('parses boolean env values', () => {
    expect(parseBooleanEnv('1')).toBe(true);
    expect(parseBooleanEnv(' true ')).toBe(true);
    expect(parseBooleanEnv('yes')).toBe(true);
    expect(parseBooleanEnv('on')).toBe(true);
    expect(parseBooleanEnv('0')).toBe(false);
    expect(parseBooleanEnv(' false ')).toBe(false);
    expect(parseBooleanEnv('no')).toBe(false);
    expect(parseBooleanEnv('off')).toBe(false);
    expect(parseBooleanEnv('')).toBeUndefined();
    expect(parseBooleanEnv('maybe')).toBeUndefined();
  });

  it('resolves env before config before default', () => {
    expect(
      resolveConfigValue({
        env: { KIMI_TEST_FLAG: '0' },
        envKey: 'KIMI_TEST_FLAG',
        configValue: true,
        defaultValue: true,
        parseEnv: parseBooleanEnv,
      }),
    ).toBe(false);

    expect(
      resolveConfigValue({
        env: {},
        envKey: 'KIMI_TEST_FLAG',
        configValue: false,
        defaultValue: true,
        parseEnv: parseBooleanEnv,
      }),
    ).toBe(false);

    expect(
      resolveConfigValue({
        env: {},
        envKey: 'KIMI_TEST_FLAG',
        defaultValue: true,
        parseEnv: parseBooleanEnv,
      }),
    ).toBe(true);
  });

  it('ignores invalid env values', () => {
    expect(
      resolveConfigValue({
        env: { KIMI_TEST_FLAG: 'invalid' },
        envKey: 'KIMI_TEST_FLAG',
        configValue: false,
        defaultValue: true,
        parseEnv: parseBooleanEnv,
      }),
    ).toBe(false);
  });
});

describe('loadRuntimeConfigSafe', () => {
  const VALID_TOML = `
default_model = "k2"

[providers.kimi]
type = "kimi"
api_key = "sk-good"

[models.k2]
provider = "kimi"
model = "kimi-for-coding"
max_context_size = 128000
`;

  async function writeTempConfig(text: string): Promise<string> {
    const configPath = join(makeTempDir(), 'config.toml');
    await writeFile(configPath, text, 'utf-8');
    return configPath;
  }

  it('loads a valid file with no warnings, matching the strict loader', async () => {
    const configPath = await writeTempConfig(VALID_TOML);
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.fileWarnings).toEqual([]);
    expect(result.envWarnings).toEqual([]);
    expect(result.config).toEqual(loadRuntimeConfig(configPath, {}));
  });

  it('returns defaults with no warnings when the file is missing', () => {
    const configPath = join(makeTempDir(), 'config.toml');
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.fileWarnings).toEqual([]);
    expect(result.envWarnings).toEqual([]);
    expect(result.config.providers).toEqual({});
  });

  it('reports a fileError and defaults on invalid TOML syntax', async () => {
    const configPath = await writeTempConfig('[[[');
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.config.providers).toEqual({});
    // The whole file is unusable: callers decide to fail startup (fileError)
    // or keep the last good config mid-run (fileWarnings).
    expect(result.fileError).toBeInstanceOf(KimiError);
    expect(result.fileError?.code).toBe(ErrorCodes.CONFIG_INVALID);
    expect(result.fileError?.message).toContain('Invalid TOML');
    expect(result.fileError?.message).toContain(configPath);
    expect(result.fileWarnings).toHaveLength(1);
    const warning = result.fileWarnings[0]!;
    expect(warning).toContain('Invalid TOML');
    // Single-line summary with the error location, not the multi-line code frame.
    expect(warning).not.toContain('\n');
    expect(warning).toContain('line 1');
  });

  it('does not set fileError when only sections are dropped', async () => {
    const configPath = await writeTempConfig(`${VALID_TOML}
[loop_control]
max_steps_per_turn = "nope"
`);
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.fileError).toBeUndefined();
    expect(result.fileWarnings).toHaveLength(1);
  });

  it('drops only an invalid section on schema errors and keeps the rest', async () => {
    const configPath = await writeTempConfig(`${VALID_TOML}
[loop_control]
max_steps_per_turn = "not-a-number"
`);
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.config.loopControl).toBeUndefined();
    expect(result.config.providers['kimi']).toMatchObject({ type: 'kimi', apiKey: 'sk-good' });
    expect(result.config.models?.['k2']).toMatchObject({ maxContextSize: 128000 });
    expect(result.config.defaultModel).toBe('k2');
    expect(result.fileWarnings).toHaveLength(1);
    expect(result.fileWarnings[0]).toContain('loop_control');
    // The original file content stays visible in raw so nothing is lost.
    expect(result.config.raw?.['loop_control']).toEqual({ max_steps_per_turn: 'not-a-number' });
  });

  it('drops only the broken provider entry, keeping other providers', async () => {
    const configPath = await writeTempConfig(`${VALID_TOML}
[providers.bad]
type = "not-a-provider"
`);
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.config.providers['bad']).toBeUndefined();
    expect(result.config.providers['kimi']).toMatchObject({ type: 'kimi' });
    expect(result.fileWarnings).toHaveLength(1);
    expect(result.fileWarnings[0]).toContain('providers.bad');
  });

  it('keeps other providers when one entry has multiple validation issues', async () => {
    // Two issues on the same entry: the second must not escalate to
    // deleting the whole providers section after the first dropped the entry.
    const configPath = await writeTempConfig(`${VALID_TOML}
[providers.bad]
type = "not-a-provider"
api_key = 123
`);
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.config.providers['bad']).toBeUndefined();
    expect(result.config.providers['kimi']).toMatchObject({ type: 'kimi' });
    expect(result.fileWarnings).toHaveLength(1);
    expect(result.fileWarnings[0]).toContain('providers.bad');
    expect(result.fileWarnings[0]).not.toMatch(/providers[,.]? /);
  });

  it('drops only the broken model entry', async () => {
    const configPath = await writeTempConfig(`${VALID_TOML}
[models.broken]
provider = "kimi"
model = "x"
max_context_size = -5
`);
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.config.models?.['broken']).toBeUndefined();
    expect(result.config.models?.['k2']).toBeDefined();
    expect(result.fileWarnings[0]).toContain('models.broken');
  });

  it('drops the whole hooks list when one hook is invalid', async () => {
    const configPath = await writeTempConfig(`${VALID_TOML}
[[hooks]]
event = "NotARealEvent"
command = "echo hi"
`);
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.config.hooks).toBeUndefined();
    expect(result.config.providers['kimi']).toBeDefined();
    expect(result.fileWarnings[0]).toContain('hooks');
  });

  it('reports every dropped section in the warning', async () => {
    const configPath = await writeTempConfig(`${VALID_TOML}
[loop_control]
max_steps_per_turn = "nope"

[background]
max_running_tasks = 0
`);
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.config.loopControl).toBeUndefined();
    expect(result.config.background).toBeUndefined();
    expect(result.fileWarnings).toHaveLength(1);
    expect(result.fileWarnings[0]).toContain('loop_control');
    expect(result.fileWarnings[0]).toContain('background');
  });

  it('applies KIMI_MODEL_* env overrides on top of a salvaged config', async () => {
    const configPath = await writeTempConfig(`${VALID_TOML}
[loop_control]
max_steps_per_turn = "nope"
`);
    const result = loadRuntimeConfigSafe(configPath, {
      KIMI_MODEL_NAME: 'env-model',
      KIMI_MODEL_API_KEY: 'sk-env',
      KIMI_MODEL_MAX_CONTEXT_SIZE: '262144',
    });
    expect(result.envWarnings).toEqual([]);
    expect(result.config.models?.['__kimi_env_model__']).toBeDefined();
    expect(result.config.providers['kimi']).toBeDefined();
    expect(result.fileWarnings).toHaveLength(1);
  });

  it('skips KIMI_MODEL_* overrides with an env warning instead of throwing', async () => {
    const configPath = await writeTempConfig(VALID_TOML);
    const result = loadRuntimeConfigSafe(configPath, {
      KIMI_MODEL_NAME: 'env-model',
    });
    expect(result.fileWarnings).toEqual([]);
    expect(result.envWarnings).toHaveLength(1);
    expect(result.envWarnings[0]).toContain('KIMI_MODEL');
    expect(result.config).toEqual(readConfigFile(configPath));
  });

  it('readConfigFileForUpdate rewraps validation errors with an actionable message', async () => {
    const configPath = await writeTempConfig(`${VALID_TOML}
[loop_control]
max_steps_per_turn = "nope"
`);
    try {
      readConfigFileForUpdate(configPath);
      throw new Error('expected readConfigFileForUpdate to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(KimiError);
      expect((error as KimiError).message).toContain('fix it first');
      expect((error as KimiError).message).toContain('kimi doctor');
      expect((error as KimiError).message).not.toContain('invalid_type');
    }

    const goodPath = await writeTempConfig(VALID_TOML);
    expect(readConfigFileForUpdate(goodPath)).toEqual(readConfigFile(goodPath));
  });

  it('drops invalid top-level scalars and keeps the rest', async () => {
    const configPath = await writeTempConfig(`default_permission_mode = "not-a-mode"
${VALID_TOML}`);
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.config.defaultPermissionMode).toBeUndefined();
    expect(result.config.providers['kimi']).toBeDefined();
    expect(result.fileWarnings).toHaveLength(1);
    expect(result.fileWarnings[0]).toContain('default_permission_mode');
  });
});

describe('model overrides TOML', () => {
  it('parses nested model overrides from snake_case TOML', () => {
    const config = parseConfigString(`
[models."kimi-code/kimi-k2"]
provider = "managed:kimi-code"
model = "kimi-k2"
max_context_size = 262144
support_efforts = ["low", "high", "max"]

[models."kimi-code/kimi-k2".overrides]
support_efforts = ["low", "high"]
default_effort = "high"
`);

    expect(config.models?.['kimi-code/kimi-k2']?.overrides).toEqual({
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
    });
  });

  it('writes nested model overrides back as snake_case TOML data', () => {
    const config = parseConfigString(`
[models."kimi-code/kimi-k2"]
provider = "managed:kimi-code"
model = "kimi-k2"
max_context_size = 262144

[models."kimi-code/kimi-k2".overrides]
support_efforts = ["low", "high"]
`);

    const data = configToTomlData(config);
    const models = data['models'] as Record<string, Record<string, unknown>>;
    const overrides = models['kimi-code/kimi-k2']?.['overrides'] as Record<string, unknown>;

    expect(overrides['support_efforts']).toEqual(['low', 'high']);
  });
});
