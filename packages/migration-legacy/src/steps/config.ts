import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import {
  ModelRecordSchema,
  ProviderConfigSchema,
  modelsFromToml,
  providersFromToml,
} from '@moonshot-ai/agent-core-v2/app/kosongConfig/configSection';
import { HookDefSchema } from '@moonshot-ai/agent-core-v2/features/externalHooks/configSection';
import { getConfigSectionContributions } from '@moonshot-ai/agent-core-v2/app/config/configSectionContributions';
import { getContributedFlags } from '@moonshot-ai/agent-core-v2/app/flag/flagRegistry';
import { camelToSnake } from '@moonshot-ai/agent-core-v2/app/config/toml';

import '@moonshot-ai/agent-core-v2/agent/loop/configSection';
import '@moonshot-ai/agent-core-v2/agent/task/configSection';
import '@moonshot-ai/agent-core-v2/agent/permissionMode/configSection';
import '@moonshot-ai/agent-core-v2/app/mcpConfig/configSection';
import '@moonshot-ai/agent-core-v2/app/auth/configSection';
import '@moonshot-ai/agent-core-v2/app/flag/flag';
import '@moonshot-ai/agent-core-v2/features/skill/catalog/configSection';

import '@moonshot-ai/agent-core-v2/session/subagent/flag';
import '@moonshot-ai/agent-core-v2/session/sessionTitle/flag';
import '@moonshot-ai/agent-core-v2/persistence/backends/minidb/flag';
import '@moonshot-ai/agent-core-v2/features/tower/flag';
import '@moonshot-ai/agent-core-v2/app/remoteControl/flag';
import '@moonshot-ai/agent-core-v2/agent/toolSelect/flag';
import '@moonshot-ai/agent-core-v2/agent/tools/task/task-wait/flag';

import { atomicWrite } from '../atomic-write.js';
import { DEFAULT_CONFIG_FILE_TEXT, isTuiStubOrMissing } from '../stub-detect.js';
import { readSourceConfig } from '../source-config.js';
import {
  targetConfigFile,
  targetTuiFile,
  siblingConfigToml,
  siblingTuiToml,
} from '../paths.js';

// `theme` / `default_editor` belong in tui.toml, not config.toml.
const TUI_TOP_LEVEL_KEYS = new Set(['theme', 'default_editor']);
const TOP_LEVEL_KEYS_TO_DROP = new Set(['plan_mode', 'yolo']);
const LOOP_CONTROL_FIELDS_TO_KEEP = new Set([
  'reserved_context_size',
]);
const BACKGROUND_FIELDS_TO_KEEP = new Set([
  'max_running_tasks',
  'keep_alive_on_exit',
]);
const REGISTERED_EXPERIMENTAL_FLAGS: ReadonlySet<string> = new Set(
  getContributedFlags().map((definition) => definition.id),
);

// kimi-code's tui.toml `theme` enum (mirrors apps/kimi-code TuiThemeSchema).
// A legacy theme outside this set would fail loadTuiConfig()'s whole-file
// validation, taking the migrated editor command down with it — so drop it.
const TUI_THEMES: ReadonlySet<string> = new Set(['dark', 'light', 'auto']);

const SUPPORTED_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  'anthropic',
  'openai',
  'kimi',
  'google-genai',
  'openai_responses',
  'vertexai',
]);

// The config.toml top-level keys kimi-code understands, derived from the v2
// config-section registry so the set tracks the v2 runtime. `providers` /
// `models` / `hooks` are filtered per-entry, not via this set. `default_model`
// / `default_provider` are unregistered-but-preserved v2 keys (the v2
// ConfigRegistry passes unregistered domains through unchanged), so they are
// kept explicitly.
const SUPPORTED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  ...getConfigSectionContributions()
    .map((contribution) => contribution.domain)
    .filter((d) => d !== 'providers' && d !== 'models' && d !== 'hooks')
    .map(camelToSnake),
  'default_model',
  'default_provider',
]);

export interface ConfigStepInput {
  readonly sourceHome: string;
  readonly targetHome: string;
}

export interface ConfigStepResult {
  readonly migrated: boolean;
  readonly tuiExtracted: boolean;
  readonly droppedProviders: readonly string[];
  readonly droppedModels: readonly string[];
  /** Top-level keys dropped because kimi-code's config schema lacks them. */
  readonly droppedKeys: readonly string[];
  /**
   * Keys/sections the existing target config and the kimi-cli config both set
   * to a different value — the target's value was kept.
   */
  readonly configConflicts: readonly string[];
  /** A `config.toml` conflict forced a `config.migrated-from-kimi-cli.toml` sibling. */
  readonly wroteSiblingDueToConflict: boolean;
  /** A `tui.toml` conflict forced a `tui.migrated-from-kimi-cli.toml` sibling. */
  readonly wroteTuiSibling: boolean;
  /** Count of kimi-cli hook entries written into the LIVE target config. */
  readonly migratedHooks: number;
  /** Count of kimi-cli hook entries dropped because kimi-code's schema rejects them. */
  readonly droppedHooks: number;
  readonly sourceUnreadable: boolean;
  /** Legacy `device_id` was copied because the target had none of its own. */
  readonly deviceIdCopied: boolean;
  /**
   * When sibling mode kicks in (`wroteSiblingDueToConflict === true`), the
   * content that landed in `config.migrated-from-kimi-cli.toml` instead of
   * the live `config.toml`. Surfaced by the result screen so the user knows
   * what they need to merge by hand. Empty in `overwrite` / `merge` modes.
   */
  readonly siblingContents: {
    readonly providers: readonly string[];
    readonly models: readonly string[];
    readonly hooks: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyResult(): ConfigStepResult {
  return {
    migrated: false,
    tuiExtracted: false,
    droppedProviders: [],
    droppedModels: [],
    droppedKeys: [],
    configConflicts: [],
    wroteSiblingDueToConflict: false,
    wroteTuiSibling: false,
    migratedHooks: 0,
    droppedHooks: 0,
    sourceUnreadable: false,
    deviceIdCopied: false,
    siblingContents: { providers: [], models: [], hooks: 0 },
  };
}

function filterFields(
  value: Record<string, unknown>,
  fieldsToKeep: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  const keptEntries = Object.entries(value).filter(([field]) => fieldsToKeep.has(field));
  return keptEntries.length > 0 ? Object.fromEntries(keptEntries) : undefined;
}

function filterRegisteredExperimentalFlags(
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const keptEntries = Object.entries(value).filter(
    ([field, flag]) => REGISTERED_EXPERIMENTAL_FLAGS.has(field) && typeof flag === 'boolean',
  );
  return keptEntries.length > 0 ? Object.fromEntries(keptEntries) : undefined;
}

/** True when the kimi-cli provider entry validates against kimi-code's v2 schema
 * and its (already type-mapped) `type` is one the kosong runtime can construct. */
function providerIsSupported(prov: Record<string, unknown>): boolean {
  const transformed = providersFromToml({ x: prov });
  const entry = isRecord(transformed) ? transformed['x'] : undefined;
  if (entry === undefined) return false;
  try {
    ProviderConfigSchema.parse(entry);
  } catch {
    return false;
  }
  const type = isRecord(entry) ? entry['type'] : undefined;
  return typeof type === 'string' && SUPPORTED_PROVIDER_TYPES.has(type);
}

/** True when the kimi-cli model entry validates against kimi-code's v2 schema. */
function modelIsSupported(mod: Record<string, unknown>): boolean {
  const transformed = modelsFromToml({ x: mod });
  const entry = isRecord(transformed) ? transformed['x'] : undefined;
  if (entry === undefined) return false;
  try {
    ModelRecordSchema.parse(entry);
    return true;
  } catch {
    return false;
  }
}

/** Order-insensitive deep-equality key, so re-ordered tables are not conflicts. */
function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableKey(a) === stableKey(b);
}

const LEGACY_PROVIDER_TYPE_MAP: Readonly<Record<string, string>> = {
  openai_legacy: 'openai',
  google_genai: 'google-genai',
  gemini: 'google-genai',
};

function mapLegacyProviderTypes(parsed: Record<string, unknown>): Record<string, unknown> {
  const providers = parsed['providers'];
  if (!isRecord(providers)) return parsed;
  let changed = false;
  const mapped: Record<string, unknown> = {};
  for (const [name, prov] of Object.entries(providers)) {
    if (!isRecord(prov)) {
      mapped[name] = prov;
      continue;
    }
    const mappedType =
      typeof prov['type'] === 'string' ? LEGACY_PROVIDER_TYPE_MAP[prov['type']] : undefined;
    if (mappedType === undefined) {
      mapped[name] = prov;
      continue;
    }
    mapped[name] = { ...prov, type: mappedType };
    changed = true;
  }
  return changed ? { ...parsed, providers: mapped } : parsed;
}

/**
 * Additively merge the kimi-cli config into the existing target config: add
 * keys/providers/models the target lacks, keep the target's value on a real
 * conflict, and record those conflicts. A target value is never overwritten.
 */
function mergeConfig(
  target: Record<string, unknown>,
  migrated: Record<string, unknown>,
): { merged: Record<string, unknown>; conflicts: string[] } {
  const merged: Record<string, unknown> = { ...target };
  const conflicts: string[] = [];
  for (const [key, value] of Object.entries(migrated)) {
    if ((key === 'providers' || key === 'models') && isRecord(value)) {
      const section: Record<string, unknown> = isRecord(merged[key]) ? { ...merged[key] } : {};
      for (const [name, entry] of Object.entries(value)) {
        if (section[name] === undefined) {
          section[name] = entry;
        } else if (!deepEqual(section[name], entry)) {
          conflicts.push(`${key}.${name}`);
        }
      }
      merged[key] = section;
      continue;
    }
    if (merged[key] === undefined) {
      merged[key] = value;
    } else if (!deepEqual(merged[key], value)) {
      conflicts.push(key);
    }
  }
  return { merged, conflicts };
}

export async function migrateConfigStep(input: ConfigStepInput): Promise<ConfigStepResult> {
  const source = await readSourceConfig(input.sourceHome);
  if (source.kind === 'missing') return emptyResult();
  if (source.kind === 'unreadable') {
    return { ...emptyResult(), sourceUnreadable: true };
  }
  const deviceIdCopied = await copyDeviceId(input.sourceHome, input.targetHome);
  const parsed: Record<string, unknown> = mapLegacyProviderTypes(source.parsed);

  // Decide how the target config.toml is handled: a missing or pristine-stub
  // target is overwritten; a parseable user config is merged into; an
  // unparseable target falls back to a side file (it cannot be merged).
  const configPath = targetConfigFile(input.targetHome);
  let targetText: string | undefined;
  try {
    targetText = await readFile(configPath, 'utf-8');
  } catch {
    targetText = undefined;
  }
  let targetMode: 'overwrite' | 'merge' | 'sibling';
  let targetParsed: Record<string, unknown> = {};
  if (targetText === undefined || targetText === DEFAULT_CONFIG_FILE_TEXT) {
    targetMode = 'overwrite';
  } else {
    try {
      const tp: unknown = parseToml(targetText);
      targetParsed = isRecord(tp) ? tp : {};
      targetMode = 'merge';
    } catch {
      targetMode = 'sibling';
    }
  }

  // Provider names available to migrated models: those kept by this run, plus
  // any already present in the target config being merged into.
  const availableProviderNames = new Set<string>(
    isRecord(targetParsed['providers']) ? Object.keys(targetParsed['providers']) : [],
  );

  // Model alias names already present in the target config being merged into —
  // a migrated `default_model` may legitimately point at one of these.
  const availableModelNames = new Set<string>(
    isRecord(targetParsed['models']) ? Object.keys(targetParsed['models']) : [],
  );

  // 1) Providers — keep only those kimi-code's schema accepts.
  const droppedProviders: string[] = [];
  const keptProviders: Record<string, Record<string, unknown>> = {};
  if (isRecord(parsed['providers'])) {
    for (const [name, prov] of Object.entries(parsed['providers'])) {
      if (isRecord(prov) && providerIsSupported(prov)) {
        keptProviders[name] = prov;
      } else {
        droppedProviders.push(name);
      }
    }
  }

  // Provider names the merge resolves to a DIFFERENT entry than the kimi-cli
  // one: the target already defines a same-named provider with other settings,
  // so `mergeConfig` keeps the target's. A migrated model bound to such a name
  // would silently run against the target's endpoint/credentials, not the
  // legacy ones it was configured for — so treat the name as unavailable.
  const targetProviders: Record<string, unknown> = isRecord(targetParsed['providers'])
    ? targetParsed['providers']
    : {};
  const conflictedProviderNames = new Set<string>();
  for (const [name, prov] of Object.entries(keptProviders)) {
    const targetProv = targetProviders[name];
    if (targetProv !== undefined && !deepEqual(targetProv, prov)) {
      conflictedProviderNames.add(name);
    }
  }

  // 2) Models — keep only those kimi-code's schema accepts, and not those
  //    whose provider was dropped as unsupported (they could never resolve).
  const droppedModels: string[] = [];
  const keptModels: Record<string, Record<string, unknown>> = {};
  if (isRecord(parsed['models'])) {
    for (const [name, mod] of Object.entries(parsed['models'])) {
      if (!isRecord(mod) || !modelIsSupported(mod)) {
        droppedModels.push(name);
        continue;
      }
      // `modelIsSupported` guarantees `provider` is a string. Keep the model
      // only if that provider is available — kept by this run or already in
      // the target config — and is not a name whose merged entry will differ
      // from the legacy provider this model was configured against.
      const provider = mod['provider'];
      if (
        typeof provider !== 'string' ||
        (keptProviders[provider] === undefined && !availableProviderNames.has(provider)) ||
        conflictedProviderNames.has(provider)
      ) {
        droppedModels.push(name);
        continue;
      }
      keptModels[name] = mod;
    }
  }

  for (const [name, prov] of Object.entries(keptProviders)) {
    const reasoningKey = prov['reasoning_key'];
    delete prov['reasoning_key'];
    if (typeof reasoningKey !== 'string' || reasoningKey.length === 0) continue;
    for (const mod of Object.values(keptModels)) {
      if (mod['provider'] === name && mod['reasoning_key'] === undefined) {
        mod['reasoning_key'] = reasoningKey;
      }
    }
  }

  // 2b) Hooks — keep only entries kimi-code's HookDefSchema accepts. kimi-cli
  //     and kimi-code share an identical hook shape, so a valid legacy hook
  //     passes straight through; the per-entry filter only guards against
  //     future schema drift (an event type / field kimi-code does not know).
  //     Hook fields are all single lowercase words, so — unlike providers /
  //     models — no `transformTomlData` snake→camel pass is needed first.
  let droppedHooks = 0;
  const keptHooks: unknown[] = [];
  if (Array.isArray(parsed['hooks'])) {
    for (const entry of parsed['hooks']) {
      if (HookDefSchema.safeParse(entry).success) {
        keptHooks.push(entry);
      } else {
        droppedHooks++;
      }
    }
  }

  // 3) Split out the keys that belong in tui.toml.
  const tuiEditor: Record<string, unknown> = {};
  const tuiOut: Record<string, unknown> = {
    editor: tuiEditor,
    notifications: { enabled: true, notification_condition: 'unfocused' },
  };
  const themeVal = parsed['theme'];
  if (typeof themeVal === 'string' && TUI_THEMES.has(themeVal)) {
    tuiOut['theme'] = themeVal;
  }
  const editorVal = parsed['default_editor'];
  if (typeof editorVal === 'string') {
    tuiEditor['command'] = editorVal;
  }

  // 4) Build the migrated top-level — only keys kimi-code's schema supports.
  const droppedKeys: string[] = [];
  const migratedTop: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k === 'providers' || k === 'models' || k === 'hooks') continue;
    if (TUI_TOP_LEVEL_KEYS.has(k)) continue;
    if (TOP_LEVEL_KEYS_TO_DROP.has(k)) continue;
    if (k === 'default_yolo') {
      // kimi-cli's `default_yolo` maps to kimi-code's `default_permission_mode`.
      if (v === true) migratedTop['default_permission_mode'] = 'yolo';
      continue;
    }
    if (!SUPPORTED_TOP_LEVEL_KEYS.has(k)) {
      droppedKeys.push(k);
      continue;
    }
    // Drop default_model unless it points at a model that will exist in the
    // written config — one kept from kimi-cli, or already in the target being
    // merged into. A dangling alias (dropped, stale, or never present) would
    // fail the next session-create.
    if (
      k === 'default_model' &&
      typeof v === 'string' &&
      keptModels[v] === undefined &&
      !availableModelNames.has(v)
    ) {
      continue;
    }
    if (k === 'loop_control' && isRecord(v)) {
      const filteredLoopControl = filterFields(v, LOOP_CONTROL_FIELDS_TO_KEEP);
      if (filteredLoopControl !== undefined) {
        migratedTop[k] = filteredLoopControl;
      }
      continue;
    }
    if (k === 'background' && isRecord(v)) {
      const filteredBackground = filterFields(v, BACKGROUND_FIELDS_TO_KEEP);
      if (filteredBackground !== undefined) {
        migratedTop[k] = filteredBackground;
      }
      continue;
    }
    if (k === 'experimental' && isRecord(v)) {
      const filteredExperimental = filterRegisteredExperimentalFlags(v);
      if (filteredExperimental !== undefined) {
        migratedTop[k] = filteredExperimental;
      }
      continue;
    }
    migratedTop[k] = v;
  }
  if (Object.keys(keptProviders).length > 0) migratedTop['providers'] = keptProviders;
  if (Object.keys(keptModels).length > 0) migratedTop['models'] = keptModels;
  if (keptHooks.length > 0) migratedTop['hooks'] = keptHooks;

  // 4b) Drop any supported top-level key whose VALUE the v2 config section
  //     rejects (e.g. `merge_all_available_skills = "yes"`). Providers/models
  //     are already validated per-entry above, so section failures here can
  //     only come from plain top-level keys. Unregistered-but-preserved keys
  //     (default_model / default_provider) have no section schema and pass.
  const sectionsBySnake = new Map(
    getConfigSectionContributions().map((contribution) => [
      camelToSnake(contribution.domain),
      contribution,
    ]),
  );
  for (const [k, v] of Object.entries(migratedTop)) {
    if (k === 'providers' || k === 'models' || k === 'hooks') continue;
    const section = sectionsBySnake.get(k);
    if (section === undefined) continue;
    const transformed =
      section.options.fromToml === undefined ? v : section.options.fromToml(v);
    try {
      section.schema.parse(transformed);
    } catch {
      delete migratedTop[k];
      droppedKeys.push(k);
    }
  }

  // 5) Write config.toml per the target mode.
  await mkdir(input.targetHome, { recursive: true, mode: 0o700 });
  let wroteConfigSibling = false;
  let configConflicts: readonly string[] = [];
  if (targetMode === 'sibling') {
    await atomicWrite(siblingConfigToml(input.targetHome), stringifyToml(migratedTop));
    wroteConfigSibling = true;
  } else if (targetMode === 'merge') {
    const { merged, conflicts } = mergeConfig(targetParsed, migratedTop);
    configConflicts = conflicts;
    await atomicWrite(configPath, stringifyToml(merged));
  } else {
    await atomicWrite(configPath, stringifyToml(migratedTop));
  }

  // 6) Write tui.toml (or a sibling if the target tui.toml is user-modified).
  const tuiPath = targetTuiFile(input.targetHome);
  const canOverwriteTui = await isTuiStubOrMissing(tuiPath);
  const renderedTui = stringifyToml(tuiOut);
  const hasThemeExtracted = tuiOut['theme'] !== undefined;
  const hasEditorExtracted = tuiEditor['command'] !== undefined;
  let wroteTuiSibling = false;
  let tuiExtracted = false;
  if (hasThemeExtracted || hasEditorExtracted) {
    if (canOverwriteTui) {
      await atomicWrite(tuiPath, renderedTui);
    } else {
      await atomicWrite(siblingTuiToml(input.targetHome), renderedTui);
      wroteTuiSibling = true;
    }
    tuiExtracted = true;
  }

  // `migratedHooks` counts hooks the runtime will actually see — i.e. hooks
  // we wrote into the LIVE `config.toml`. That happens only when:
  //  - overwrite mode (target was missing / pristine stub, we wrote fresh), or
  //  - merge mode AND the target had no `hooks` key (mergeConfig added ours).
  // In merge mode where target already declares `hooks` (any value: empty,
  // identical, different, or even non-array invalid), `mergeConfig` keeps
  // the target's value, so the source hooks never land in the live config.
  // In sibling mode the source hooks land in `config.migrated-from-kimi-cli.toml`,
  // which the runtime never reads — they're accounted for via `siblingContents`,
  // not `migratedHooks`.
  const hooksLandedInLiveConfig =
    keptHooks.length > 0 &&
    (targetMode === 'overwrite' ||
      (targetMode === 'merge' && targetParsed['hooks'] === undefined));
  const migratedHooks = hooksLandedInLiveConfig ? keptHooks.length : 0;

  // In sibling mode, enumerate what landed in the sibling file so the result
  // screen can tell the user exactly what is awaiting manual merge.
  const siblingContents =
    targetMode === 'sibling'
      ? {
          providers: Object.keys(keptProviders),
          models: Object.keys(keptModels),
          hooks: keptHooks.length,
        }
      : { providers: [] as string[], models: [] as string[], hooks: 0 };

  return {
    migrated: true,
    tuiExtracted,
    droppedProviders,
    droppedModels,
    droppedKeys,
    configConflicts,
    wroteSiblingDueToConflict: wroteConfigSibling,
    wroteTuiSibling,
    migratedHooks,
    droppedHooks,
    sourceUnreadable: false,
    deviceIdCopied,
    siblingContents,
  };
}

// Telemetry identity continuity: kimi-cli and kimi-code share the same
// `device_id` concept (uuid hex, `kfc_device_id_` user-id prefix). Copy it only
// when the target has none — a target that already launched once keeps its own.
async function copyDeviceId(sourceHome: string, targetHome: string): Promise<boolean> {
  const targetPath = join(targetHome, 'device_id');
  if (existsSync(targetPath)) return false;
  let content: string;
  try {
    content = await readFile(join(sourceHome, 'device_id'), 'utf-8');
  } catch {
    return false;
  }
  if (content.trim().length === 0) return false;
  await mkdir(targetHome, { recursive: true, mode: 0o700 });
  await writeFile(targetPath, content, { mode: 0o600 });
  return true;
}
