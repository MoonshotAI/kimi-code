import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateConfigStep } from '../../src/steps/config.js';
import { DEFAULT_CONFIG_FILE_TEXT } from '../../src/stub-detect.js';

let src: string;
let tgt: string;
beforeEach(async () => {
  src = await mkdtemp(join(tmpdir(), 'src-'));
  tgt = await mkdtemp(join(tmpdir(), 'tgt-'));
});
afterEach(async () => {
  await rm(src, { recursive: true, force: true });
  await rm(tgt, { recursive: true, force: true });
});

const OLD_CONFIG_TOML = `default_model = "internal-vibe"
merge_all_available_skills = true
theme = "dark"
default_editor = "code --wait"
default_yolo = false
telemetry = true

[models."internal-vibe"]
provider = "vllm"
model = "vllm-mooncake"
max_context_size = 131072

[providers.vllm]
type = "openai_legacy"
base_url = "https://internal.example.com/v1"
api_key = "EMPTY"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"
`;

describe('migrateConfigStep', () => {
  it('writes config.toml + tui.toml on a clean target (stub fallback)', async () => {
    await writeFile(join(src, 'config.toml'), OLD_CONFIG_TOML);
    // Pre-create target with default stubs to simulate post-startup state
    await writeFile(join(tgt, 'config.toml'), DEFAULT_CONFIG_FILE_TEXT);
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.migrated).toBe(true);
    expect(r.wroteSiblingDueToConflict).toBe(false);
    const cfg = await readFile(join(tgt, 'config.toml'), 'utf-8');
    expect(cfg).toContain('merge_all_available_skills = true');
    expect(cfg).not.toContain('"vllm"'); // dropped provider
    expect(cfg).not.toContain('"internal-vibe"'); // dropped model
    expect(cfg).not.toContain('theme'); // moved to tui
    const tui = await readFile(join(tgt, 'tui.toml'), 'utf-8');
    expect(tui).toContain('theme = "dark"');
    expect(tui).toContain('command = "code --wait"');
    expect(r.droppedProviders).toContain('vllm');
    expect(r.droppedModels).toContain('internal-vibe');
  });

  it('additively merges into a user-modified target config', async () => {
    await writeFile(join(src, 'config.toml'), OLD_CONFIG_TOML);
    await writeFile(join(tgt, 'config.toml'), 'merge_all_available_skills = false\n');
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.wroteSiblingDueToConflict).toBe(false);
    // merge_all_available_skills is set on both, differently → target's value is kept
    // and the key is reported as a conflict.
    expect(r.configConflicts).toContain('merge_all_available_skills');
    const cfg = await readFile(join(tgt, 'config.toml'), 'utf-8');
    expect(cfg).toContain('merge_all_available_skills = false'); // target value kept
    expect(cfg).toContain('telemetry = true'); // additively brought over
    expect(cfg).toContain('kimi-code/kimi-for-coding'); // migrated model added
  });

  it('reports a provider conflict and keeps the target provider', async () => {
    await writeFile(
      join(src, 'config.toml'),
      `[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://source.example/v1"
`,
    );
    await writeFile(
      join(tgt, 'config.toml'),
      `[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://target.example/v1"
`,
    );
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.configConflicts).toContain('providers.managed:kimi-code');
    const cfg = await readFile(join(tgt, 'config.toml'), 'utf-8');
    expect(cfg).toContain('https://target.example/v1');
    expect(cfg).not.toContain('https://source.example/v1');
  });

  it('drops top-level keys kimi-code does not support', async () => {
    await writeFile(
      join(src, 'config.toml'),
      'show_thinking_stream = true\nmerge_all_available_skills = true\n',
    );
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.droppedKeys).toContain('show_thinking_stream');
    const cfg = await readFile(join(tgt, 'config.toml'), 'utf-8');
    expect(cfg).not.toContain('show_thinking_stream');
    expect(cfg).toContain('merge_all_available_skills');
  });

  it('falls back to a sibling file when the target config is unparseable', async () => {
    await writeFile(join(src, 'config.toml'), 'merge_all_available_skills = true\n');
    await writeFile(join(tgt, 'config.toml'), 'this is = = not valid toml [[[');
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.wroteSiblingDueToConflict).toBe(true);
    expect(
      await readFile(join(tgt, 'config.migrated-from-kimi-cli.toml'), 'utf-8'),
    ).toContain('merge_all_available_skills');
    // the unparseable target is left untouched
    expect(await readFile(join(tgt, 'config.toml'), 'utf-8')).toContain('not valid toml');
  });

  it('a tui.toml-only conflict sets wroteTuiSibling, not wroteSiblingDueToConflict', async () => {
    await writeFile(join(src, 'config.toml'), OLD_CONFIG_TOML);
    // config.toml target is a stub (overwritable) — only tui.toml conflicts.
    await writeFile(join(tgt, 'config.toml'), DEFAULT_CONFIG_FILE_TEXT);
    await writeFile(join(tgt, 'tui.toml'), 'theme = "light"\n# user added\n');
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.wroteSiblingDueToConflict).toBe(false);
    expect(r.wroteTuiSibling).toBe(true);
    expect(
      await readFile(join(tgt, 'tui.migrated-from-kimi-cli.toml'), 'utf-8'),
    ).toContain('theme');
    // original kept
    expect(await readFile(join(tgt, 'tui.toml'), 'utf-8')).toContain('# user added');
  });

  it('no source config means migrated=false, no writes', async () => {
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.migrated).toBe(false);
  });

  it('treats malformed source config.toml as skipped, does not throw', async () => {
    await writeFile(join(src, 'config.toml'), 'this is = = not valid toml [[[');
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.migrated).toBe(false);
  });

  it('drops a kept-provider model missing required schema fields', async () => {
    // `bad-model` references the kept `managed:kimi-code` provider but omits
    // `max_context_size`, which kimi-code's ModelAliasSchema requires. Written
    // verbatim it would make getConfig() reject the whole config post-migration.
    const cfg = `[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"

[models."good-model"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144

[models."bad-model"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
`;
    await writeFile(join(src, 'config.toml'), cfg);
    await writeFile(join(tgt, 'config.toml'), DEFAULT_CONFIG_FILE_TEXT);
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.migrated).toBe(true);
    expect(r.droppedModels).toContain('bad-model');
    expect(r.droppedModels).not.toContain('good-model');
    const written = await readFile(join(tgt, 'config.toml'), 'utf-8');
    expect(written).toContain('good-model');
    expect(written).not.toContain('bad-model');
  });

  it('does not write an empty hooks array', async () => {
    // An empty `hooks` array yields no kept hooks, so no `hooks` key is written.
    await writeFile(join(src, 'config.toml'), 'hooks = []\nmerge_all_available_skills = true\n');
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.migrated).toBe(true);
    const cfg = await readFile(join(tgt, 'config.toml'), 'utf-8');
    expect(cfg).not.toContain('hooks');
    expect(cfg).toContain('merge_all_available_skills');
  });

  it('drops default_model when it points at a model that was not kept', async () => {
    await writeFile(
      join(src, 'config.toml'),
      'default_model = "ghost-model"\nmerge_all_available_skills = true\n',
    );
    await writeFile(join(tgt, 'config.toml'), DEFAULT_CONFIG_FILE_TEXT);
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.migrated).toBe(true);
    const cfg = await readFile(join(tgt, 'config.toml'), 'utf-8');
    // `ghost-model` has no [models."ghost-model"] entry — a dangling
    // default_model would fail the next session-create.
    expect(cfg).not.toContain('default_model');
    expect(cfg).toContain('merge_all_available_skills');
  });

  it('drops a model whose provider has no entry anywhere', async () => {
    const cfg = `[providers."managed:kimi-code"]
type = "kimi"
api_key = "k"
base_url = "https://api.example/v1"

[models."good"]
provider = "managed:kimi-code"
model = "m"
max_context_size = 1000

[models."orphan"]
provider = "ghost-provider"
model = "m"
max_context_size = 1000
`;
    await writeFile(join(src, 'config.toml'), cfg);
    await writeFile(join(tgt, 'config.toml'), DEFAULT_CONFIG_FILE_TEXT);
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.droppedModels).toContain('orphan');
    expect(r.droppedModels).not.toContain('good');
    const written = await readFile(join(tgt, 'config.toml'), 'utf-8');
    expect(written).toMatch(/models[.[].*good/);
    expect(written).not.toContain('orphan');
  });

  it('drops a supported top-level key whose value the schema rejects', async () => {
    await writeFile(join(src, 'config.toml'), 'telemetry = "false"\nmerge_all_available_skills = true\n');
    await writeFile(join(tgt, 'config.toml'), DEFAULT_CONFIG_FILE_TEXT);
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.migrated).toBe(true);
    // `telemetry` is a supported key, but the string "false" is not a boolean
    // — writing it verbatim would make the next getConfig() reject the file.
    expect(r.droppedKeys).toContain('telemetry');
    const cfg = await readFile(join(tgt, 'config.toml'), 'utf-8');
    expect(cfg).not.toContain('telemetry');
    expect(cfg).toContain('merge_all_available_skills');
  });

  it('keeps default_model that points at a model only present in the target config', async () => {
    await writeFile(
      join(src, 'config.toml'),
      'default_model = "target-only"\nmerge_all_available_skills = true\n',
    );
    // A user-modified target (merge mode) that already defines the alias.
    await writeFile(
      join(tgt, 'config.toml'),
      `[models."target-only"]
provider = "managed:kimi-code"
model = "m"
max_context_size = 1000
`,
    );
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.migrated).toBe(true);
    const cfg = await readFile(join(tgt, 'config.toml'), 'utf-8');
    // `target-only` survives the merge in [models]; the legacy default points
    // at it, so it must be carried over rather than dropped as dangling.
    expect(cfg).toContain('default_model = "target-only"');
  });

  it('drops a migrated model whose provider conflicts with a differing target provider', async () => {
    await writeFile(
      join(src, 'config.toml'),
      `[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://legacy.example/v1"

[models."conflicted"]
provider = "managed:kimi-code"
model = "m"
max_context_size = 1000
`,
    );
    // Target already defines a same-named provider with DIFFERENT settings;
    // the merge keeps the target's, so the migrated alias would silently bind
    // to the wrong backend.
    await writeFile(
      join(tgt, 'config.toml'),
      `[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://target.example/v1"
`,
    );
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.configConflicts).toContain('providers.managed:kimi-code');
    expect(r.droppedModels).toContain('conflicted');
    const cfg = await readFile(join(tgt, 'config.toml'), 'utf-8');
    expect(cfg).not.toContain('conflicted');
  });

  it('drops a legacy theme outside the kimi-code TUI enum', async () => {
    await writeFile(join(src, 'config.toml'), 'theme = "solarized"\ndefault_editor = "vim"\n');
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.tuiExtracted).toBe(true);
    const tui = await readFile(join(tgt, 'tui.toml'), 'utf-8');
    // An unsupported theme would make loadTuiConfig() reject the whole file.
    expect(tui).not.toContain('solarized');
    expect(tui).not.toContain('theme =');
    // The migrated editor command must still survive.
    expect(tui).toContain('command = "vim"');
  });

  it('migrates valid hooks onto a clean target', async () => {
    await writeFile(
      join(src, 'config.toml'),
      '[[hooks]]\n' +
        'event = "PreToolUse"\n' +
        'matcher = "Bash"\n' +
        'command = "echo pre"\n' +
        'timeout = 30\n\n' +
        '[[hooks]]\n' +
        'event = "Stop"\n' +
        'command = "echo stop"\n',
    );
    await writeFile(join(tgt, 'config.toml'), DEFAULT_CONFIG_FILE_TEXT);
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.migratedHooks).toBe(2);
    expect(r.droppedHooks).toBe(0);
    const cfg = await readFile(join(tgt, 'config.toml'), 'utf-8');
    expect(cfg).toContain('[[hooks]]');
    expect(cfg).toContain('event = "PreToolUse"');
    expect(cfg).toContain('command = "echo stop"');
  });

  it('drops a single hook kimi-code\'s schema rejects, keeps the rest', async () => {
    await writeFile(
      join(src, 'config.toml'),
      '[[hooks]]\n' +
        'event = "PreToolUse"\n' +
        'command = "echo ok"\n\n' +
        '[[hooks]]\n' +
        'event = "NotARealEvent"\n' +
        'command = "echo bad"\n',
    );
    await writeFile(join(tgt, 'config.toml'), DEFAULT_CONFIG_FILE_TEXT);
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.migratedHooks).toBe(1);
    expect(r.droppedHooks).toBe(1);
    const cfg = await readFile(join(tgt, 'config.toml'), 'utf-8');
    expect(cfg).toContain('command = "echo ok"');
    expect(cfg).not.toContain('NotARealEvent');
  });

  it('does not migrate hooks when the target config already declares hooks', async () => {
    await writeFile(
      join(src, 'config.toml'),
      '[[hooks]]\nevent = "PreToolUse"\ncommand = "echo from-cli"\n',
    );
    await writeFile(
      join(tgt, 'config.toml'),
      '[[hooks]]\nevent = "Stop"\ncommand = "echo target-own"\n',
    );
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.migratedHooks).toBe(0);
    expect(r.configConflicts).toContain('hooks');
    const cfg = await readFile(join(tgt, 'config.toml'), 'utf-8');
    expect(cfg).toContain('echo target-own'); // target's hooks kept
    expect(cfg).not.toContain('echo from-cli'); // migrated hooks not applied
  });

  it('migrates hooks into a user-modified target that has no hooks key', async () => {
    await writeFile(
      join(src, 'config.toml'),
      '[[hooks]]\nevent = "PreToolUse"\ncommand = "echo from-cli"\n',
    );
    await writeFile(join(tgt, 'config.toml'), 'merge_all_available_skills = false\n');
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.migratedHooks).toBe(1);
    expect(r.configConflicts).not.toContain('hooks');
    const cfg = await readFile(join(tgt, 'config.toml'), 'utf-8');
    expect(cfg).toContain('echo from-cli');
  });

  it('reports migratedHooks=0 when target already has the identical hooks (idempotent re-run)', async () => {
    // After a successful first run the target ends up with the same hooks as
    // the source. A second `migrateConfigStep` call must not falsely claim
    // "N hooks migrated" again — `mergeConfig` records no conflict when the
    // values deep-equal, so checking the conflict list alone misses this case.
    const hooksToml =
      '[[hooks]]\nevent = "PreToolUse"\ncommand = "echo same"\ntimeout = 30\n';
    await writeFile(join(src, 'config.toml'), hooksToml);
    await writeFile(join(tgt, 'config.toml'), hooksToml);
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.migratedHooks).toBe(0);
    expect(r.configConflicts).not.toContain('hooks');
  });

  it('reports migratedHooks=0 and populates siblingContents when sibling mode kicks in', async () => {
    // The live `config.toml` is unparseable → migration falls back to writing
    // `config.migrated-from-kimi-cli.toml`. Hooks land in the sibling, NOT in
    // the live config, so `migratedHooks` must be 0 (the runtime never sees
    // them) and the sibling contents must be enumerated so the result-screen
    // warning can tell the user what is in the sibling.
    await writeFile(
      join(src, 'config.toml'),
      [
        'merge_all_available_skills = true',
        '[providers.openai]',
        'type = "openai"',
        'api_key = "k"',
        '[models.gpt4]',
        'provider = "openai"',
        'model = "gpt-4"',
        'max_context_size = 8192',
        '[[hooks]]',
        'event = "PreToolUse"',
        'command = "echo a"',
        '[[hooks]]',
        'event = "Stop"',
        'command = "echo b"',
      ].join('\n') + '\n',
    );
    await writeFile(join(tgt, 'config.toml'), 'this is = = not valid toml [[[');

    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });

    expect(r.wroteSiblingDueToConflict).toBe(true);
    expect(r.migratedHooks).toBe(0);
    expect(r.siblingContents.providers).toEqual(['openai']);
    expect(r.siblingContents.models).toEqual(['gpt4']);
    expect(r.siblingContents.hooks).toBe(2);
  });

  it('drops legacy migration fields but keeps supported loop and background fields', async () => {
    await writeFile(
      join(src, 'config.toml'),
      'merge_all_available_skills = true\n' +
        'plan_mode = true\n' +
        'yolo = true\n' +
        '[experimental]\n' +
        'micro_compaction = false\n' +
        'unknown_flag = true\n' +
        '[loop_control]\n' +
        'max_steps_per_turn = 1000\n' +
        'max_steps_per_run = 42\n' +
        'max_retries_per_step = 2\n' +
        'max_ralph_iterations = 3\n' +
        'reserved_context_size = 60000\n' +
        'compaction_trigger_ratio = 0.7\n' +
        '[background]\n' +
        'max_running_tasks = 8\n' +
        'keep_alive_on_exit = true\n' +
        'kill_grace_period_ms = 2000\n' +
        'print_wait_ceiling_s = 3600\n' +
        'read_max_bytes = 30000\n',
    );

    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });

    expect(r.migrated).toBe(true);
    const cfg = await readFile(join(tgt, 'config.toml'), 'utf-8');
    expect(cfg).toContain('[experimental]');
    expect(cfg).toContain('micro_compaction = false');
    expect(cfg).not.toContain('unknown_flag');
    expect(cfg).toContain('[loop_control]');
    expect(cfg).toContain('max_retries_per_step = 2');
    expect(cfg).toContain('reserved_context_size = 60000');
    expect(cfg).not.toContain('max_steps_per_turn');
    expect(cfg).not.toContain('max_steps_per_run');
    expect(cfg).not.toContain('max_ralph_iterations');
    expect(cfg).not.toContain('compaction_trigger_ratio');
    expect(cfg).toContain('[background]');
    expect(cfg).toContain('max_running_tasks = 8');
    expect(cfg).toContain('keep_alive_on_exit = true');
    expect(cfg).not.toContain('kill_grace_period_ms');
    expect(cfg).not.toContain('print_wait_ceiling_s');
    expect(cfg).not.toContain('read_max_bytes');
    expect(cfg).not.toContain('plan_mode = true');
    expect(cfg).not.toContain('yolo = true');
  });

  it('maps default_yolo to default_permission_mode = "yolo"', async () => {
    await writeFile(
      join(src, 'config.toml'),
      'default_yolo = true\n',
    );
    const r = await migrateConfigStep({ sourceHome: src, targetHome: tgt });
    expect(r.migrated).toBe(true);
    const written = await readFile(join(tgt, 'config.toml'), 'utf-8');
    expect(written).toContain('default_permission_mode = "yolo"');
    expect(written).not.toContain('yolo = true');
  });
});
