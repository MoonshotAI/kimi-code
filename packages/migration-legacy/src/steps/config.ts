import { readFile, mkdir } from 'node:fs/promises';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import {
  HookDefSchema,
  KimiConfigSchema,
  ModelAliasSchema,
  ProviderConfigSchema,
  transformTomlData,
} from '@moonshot-ai/agent-core';
import { atomicWrite } from '../atomic-write.js';
import { DEFAULT_CONFIG_FILE_TEXT, isTuiStubOrMissing } from '../stub-detect.js';
import {
  sourceConfigToml,
  targetConfigFile,
  targetTuiFile,
  siblingConfigToml,
  siblingTuiToml,
} from '../paths.js';

// `theme` / `default_editor` belong in tui.toml, not config.toml.
const TUI_TOP_LEVEL_KEYS = new Set(['theme', 'default_editor']);

// kimi-code's tui.toml `theme` enum (mirrors apps/kimi-code TuiThemeSchema).
// A legacy theme outside this set would fail loadTuiConfig()'s whole-file
// validation, taking the migrated editor command down with it — so drop it.
const TUI_THEMES: ReadonlySet<string> = new Set(['dark', 'light', 'auto']);

function camelToSnake(s: string): string {
  return s.replaceAll(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// The config.toml top-level keys kimi-code understands, derived from the live
// KimiConfigSchema so the set tracks kimi-code automatically. `raw` is internal
// — never migrate it. `providers` / `models` / `hooks` are filtered per-entry,
// not via this set.
const SUPPORTED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(
  Object.keys(KimiConfigSchema.shape)
    .filter((k) => k !== 'raw' && k !== 'providers' && k !== 'models' && k !== 'hooks')
    .map(camelToSnake),
);

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
    siblingContents: { providers: [], models: [], hooks: 0 },
  };
}

/** True when the kimi-cli provider entry validates against kimi-code's schema. */
function providerIsSupported(prov: Record<string, unknown>): boolean {
  const transformed = transformTomlData({ providers: { x: prov } });
  const entry = isRecord(transformed['providers']) ? transformed['providers']['x'] : undefined;
  return ProviderConfigSchema.safeParse(entry).success;
}

/** True when the kimi-cli model entry validates against kimi-code's schema. */
function modelIsSupported(mod: Record<string, unknown>): boolean {
  const transformed = transformTomlData({ models: { x: mod } });
  const entry = isRecord(transformed['models']) ? transformed['models']['x'] : undefined;
  return ModelAliasSchema.safeParse(entry).success;
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
  let oldText: string;
  try {
    oldText = await readFile(sourceConfigToml(input.sourceHome), 'utf-8');
  } catch {
    return emptyResult();
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = parseToml(oldText);
  } catch {
    // Malformed legacy config.toml: skip config migration rather than aborting
    // the whole run. sessions/MCP/history still migrate.
    return emptyResult();
  }
  const parsed: Record<string, unknown> = isRecord(parsedRaw) ? parsedRaw : {};

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
    migratedTop[k] = v;
  }
  if (Object.keys(keptProviders).length > 0) migratedTop['providers'] = keptProviders;
  if (Object.keys(keptModels).length > 0) migratedTop['models'] = keptModels;
  if (keptHooks.length > 0) migratedTop['hooks'] = keptHooks;

  // 4b) Drop any supported top-level key whose VALUE kimi-code's config
  //     schema rejects (e.g. `telemetry = "false"`, `extra_skill_dirs = "/tmp"`).
  //     Providers/models are already validated per-entry above, so schema
  //     failures here can only come from plain top-level keys.
  for (;;) {
    const result = KimiConfigSchema.safeParse(transformTomlData(migratedTop));
    if (result.success) break;
    const badKeys = new Set<string>();
    for (const issue of result.error.issues) {
      const top = issue.path[0];
      if (typeof top === 'string' && top !== 'providers' && top !== 'models') {
        badKeys.add(camelToSnake(top));
      }
    }
    if (badKeys.size === 0) break; // cannot attribute — stop rather than loop
    for (const k of badKeys) {
      if (k in migratedTop) {
        delete migratedTop[k];
        droppedKeys.push(k);
      }
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
    siblingContents,
  };
}
