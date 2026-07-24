/**
 * Client-owned preferences.
 *
 * Agent/runtime settings live in core's `config.toml`; this file owns
 * kimi-code client preferences such as terminal UI and update behavior.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

import { getDataDir } from '#/utils/paths';

export const INVALID_TUI_CONFIG_MESSAGE =
  'Invalid TUI config in ~/.kimi-code/tui.toml; using defaults.';

export const TuiThemeSchema = z.string();

export const NotificationConditionSchema = z.enum(['unfocused', 'always']);

export const NotificationsConfigSchema = z.object({
  enabled: z.boolean(),
  condition: NotificationConditionSchema,
});

export const UpgradePreferencesSchema = z.object({
  autoInstall: z.boolean(),
});

/** Lower bound for the statusline refresh period; tighter loops just fork spam. */
export const STATUSLINE_MIN_INTERVAL_MS = 300;

export const StatusLineConfigSchema = z.object({
  command: z.string().nullable(),
  intervalMs: z.number().int().min(STATUSLINE_MIN_INTERVAL_MS),
  timeoutMs: z.number().int().positive(),
});

export const TuiConfigFileSchema = z.object({
  theme: TuiThemeSchema.optional(),
  disable_paste_burst: z.boolean().optional(),
  editor: z
    .object({
      command: z.string().optional(),
    })
    .optional(),
  notifications: z
    .object({
      enabled: z.boolean().optional(),
      notification_condition: NotificationConditionSchema.optional(),
    })
    .optional(),
  upgrade: z
    .object({
      auto_install: z.boolean().optional(),
    })
    .optional(),
  statusline: z
    .object({
      command: z.string().optional(),
      interval_ms: z.number().int().optional(),
      timeout_ms: z.number().int().optional(),
    })
    .optional(),
});

export const TuiConfigSchema = z.object({
  theme: TuiThemeSchema,
  disablePasteBurst: z.boolean(),
  editorCommand: z.string().nullable(),
  notifications: NotificationsConfigSchema,
  upgrade: UpgradePreferencesSchema,
  statusLine: StatusLineConfigSchema,
});

export type TuiConfigFileShape = z.infer<typeof TuiConfigFileSchema>;
export type TuiConfig = z.infer<typeof TuiConfigSchema>;
export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;
export type UpgradePreferences = z.infer<typeof UpgradePreferencesSchema>;
export type StatusLineConfig = z.infer<typeof StatusLineConfigSchema>;

export const DEFAULT_NOTIFICATIONS_CONFIG: NotificationsConfig = {
  enabled: true,
  condition: 'unfocused',
};

export const DEFAULT_UPGRADE_PREFERENCES: UpgradePreferences = {
  autoInstall: true,
};

export const DEFAULT_STATUSLINE_CONFIG: StatusLineConfig = {
  command: null,
  intervalMs: 2_000,
  timeoutMs: 5_000,
};

export const DEFAULT_TUI_CONFIG: TuiConfig = TuiConfigSchema.parse({
  theme: 'auto',
  disablePasteBurst: false,
  editorCommand: null,
  notifications: DEFAULT_NOTIFICATIONS_CONFIG,
  upgrade: DEFAULT_UPGRADE_PREFERENCES,
  statusLine: DEFAULT_STATUSLINE_CONFIG,
});

/**
 * Thrown by `loadTuiConfig` when the on-disk TOML cannot be parsed.
 * Carries `fallback` so the caller can recover without re-running the
 * I/O, and use `message` (== `INVALID_TUI_CONFIG_MESSAGE`) as a
 * user-facing notice.
 */
export class TuiConfigParseError extends Error {
  override readonly name = 'TuiConfigParseError';
  readonly fallback: TuiConfig;
  constructor(fallback: TuiConfig) {
    super(INVALID_TUI_CONFIG_MESSAGE);
    this.fallback = fallback;
  }
}

export function getTuiConfigPath(): string {
  return join(getDataDir(), 'tui.toml');
}

export async function loadTuiConfig(filePath: string = getTuiConfigPath()): Promise<TuiConfig> {
  if (!existsSync(filePath)) {
    await saveTuiConfig(DEFAULT_TUI_CONFIG, filePath);
    return DEFAULT_TUI_CONFIG;
  }

  try {
    const text = await readFile(filePath, 'utf-8');
    return parseTuiConfig(text);
  } catch {
    throw new TuiConfigParseError(DEFAULT_TUI_CONFIG);
  }
}

export function parseTuiConfig(tomlText: string): TuiConfig {
  if (tomlText.trim().length === 0) {
    return DEFAULT_TUI_CONFIG;
  }
  const raw = parseToml(tomlText) as Record<string, unknown>;
  const parsed = TuiConfigFileSchema.parse(raw);
  return normalizeTuiConfig(parsed);
}

export async function saveTuiConfig(
  config: TuiConfig,
  filePath: string = getTuiConfigPath(),
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, renderTuiConfig(config), 'utf-8');
}

export function normalizeTuiConfig(config: TuiConfigFileShape): TuiConfig {
  const command = config.editor?.command?.trim();
  const statusLineCommand = config.statusline?.command?.trim();
  return TuiConfigSchema.parse({
    theme: config.theme ?? DEFAULT_TUI_CONFIG.theme,
    disablePasteBurst: config.disable_paste_burst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
    editorCommand: command === undefined || command.length === 0 ? null : command,
    notifications: {
      enabled: config.notifications?.enabled ?? DEFAULT_NOTIFICATIONS_CONFIG.enabled,
      condition:
        config.notifications?.notification_condition ?? DEFAULT_NOTIFICATIONS_CONFIG.condition,
    },
    upgrade: {
      autoInstall: config.upgrade?.auto_install ?? DEFAULT_UPGRADE_PREFERENCES.autoInstall,
    },
    statusLine: {
      command:
        statusLineCommand === undefined || statusLineCommand.length === 0
          ? null
          : statusLineCommand,
      // Clamp instead of rejecting: a typo in one preference should not
      // discard the whole config file.
      intervalMs: Math.max(
        STATUSLINE_MIN_INTERVAL_MS,
        config.statusline?.interval_ms ?? DEFAULT_STATUSLINE_CONFIG.intervalMs,
      ),
      timeoutMs: Math.max(
        1,
        config.statusline?.timeout_ms ?? DEFAULT_STATUSLINE_CONFIG.timeoutMs,
      ),
    },
  });
}

export function renderTuiConfig(config: TuiConfig): string {
  return `# ~/.kimi-code/tui.toml
# Client preferences for kimi-code.
# Agent/runtime settings stay in ~/.kimi-code/config.toml.

theme = "${escapeTomlBasicString(config.theme)}" # "auto" | "dark" | "light" | custom theme name
disable_paste_burst = ${String(config.disablePasteBurst)} # true disables non-bracketed paste-burst fallback

[editor]
command = "${escapeTomlBasicString(config.editorCommand ?? '')}" # Empty uses $VISUAL / $EDITOR

[notifications]
enabled = ${String(config.notifications.enabled)} # true | false
notification_condition = "${config.notifications.condition}" # "unfocused" | "always"

[upgrade]
auto_install = ${String(config.upgrade.autoInstall)} # true | false

[statusline]
command = "${escapeTomlBasicString(config.statusLine.command ?? '')}" # Empty disables the statusline
interval_ms = ${String(config.statusLine.intervalMs)} # Refresh period; clamped to >= ${String(STATUSLINE_MIN_INTERVAL_MS)}
timeout_ms = ${String(config.statusLine.timeoutMs)} # Per-run timeout; the process is killed past it
`;
}

function escapeTomlBasicString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\b', '\\b')
    .replaceAll('\t', '\\t')
    .replaceAll('\n', '\\n')
    .replaceAll('\f', '\\f')
    .replaceAll('\r', '\\r');
}
