import { mkdtempSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import { ErrorCodes, KimiError } from '../../src/errors';
import {
  KimiConfigSchema,
  ensureConfigFile,
  mergeConfigPatch,
  parseConfigString,
  parseBooleanEnv,
  readConfigFile,
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
default_thinking = true
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
mode = "auto"
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
    expect(config.defaultThinking).toBe(true);
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
    expect(config.thinking).toEqual({ mode: 'auto', effort: 'medium' });
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
base_url = "https://coding.deva.msh.team/coding/v1"
api_key = ""
oauth = { storage = "file", key = "oauth/kimi-code-env-1234", oauth_host = "https://auth.dev.kimi.team" }

[services.moonshot_search]
base_url = "https://coding.deva.msh.team/coding/v1/search"
api_key = ""
oauth = { storage = "file", key = "oauth/kimi-code-env-1234", oauth_host = "https://auth.dev.kimi.team" }
`;
    const config = parseConfigString(toml, configPath);
    expect(config.providers['managed:kimi-code']?.oauth).toEqual({
      storage: 'file',
      key: 'oauth/kimi-code-env-1234',
      oauthHost: 'https://auth.dev.kimi.team',
    });
    expect(config.services?.moonshotSearch?.oauth?.oauthHost).toBe('https://auth.dev.kimi.team');

    await writeConfigFile(configPath, config);
    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('oauth_host = "https://auth.dev.kimi.team"');
    const roundTripped = parseConfigString(text, configPath);
    expect(roundTripped.providers['managed:kimi-code']?.oauth?.oauthHost).toBe(
      'https://auth.dev.kimi.team',
    );
  });

  it('parses and round-trips experimental feature flags', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'experimental.toml');
    const toml = `
[experimental]
goal_command = true
micro_compaction = false
background_ask = true
`;
    const config = parseConfigString(toml, configPath);

    expect(config.experimental).toEqual({
      'goal_command': true,
      'micro_compaction': false,
      'background_ask': true,
    });

    await writeConfigFile(configPath, config);
    const text = await readFile(configPath, 'utf-8');

    expect(text).toContain('[experimental]');
    expect(text).toContain('goal_command = true');
    expect(text).toContain('micro_compaction = false');
    expect(text).toContain('background_ask = true');
    expect(parseConfigString(text, configPath).experimental).toEqual(config.experimental);
  });

  it('rejects unknown experimental feature keys', () => {
    expectKimiErrorCode(
      () =>
        parseConfigString(
          `
[experimental]
not_registered = true
`,
          'unknown-experimental.toml',
        ),
      ErrorCodes.CONFIG_INVALID,
    );
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
    expect(config.defaultThinking).toBeUndefined();
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
    expect(merged.thinking).toEqual({ mode: 'auto', effort: 'high' });
    expect(merged.hooks).toEqual(base.hooks);
    expect(merged.raw?.['theme']).toBe('dark');
  });

  it('deep-merges experimental config patches', () => {
    const base = parseConfigString(`
[experimental]
goal_command = true
micro_compaction = false
`);

    const merged = mergeConfigPatch(base, {
      experimental: {
        'micro_compaction': true,
      },
    });

    expect(merged.experimental).toEqual({
      'goal_command': true,
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
