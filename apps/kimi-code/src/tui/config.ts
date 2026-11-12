/**
 * Client-owned preferences.
 *
 * Agent/runtime settings live in core's `config.toml`; this file owns
 * kimi-code client preferences such as terminal UI and update behavior.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { MAX_ANIMATION_FRAME_RATE } from '@moonshot-ai/pi-tui';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

import type { MermaidRenderMode } from '#/tui/utils/markdown-options';
import { getDataDir } from '#/utils/paths';
import { resolveCommandPath } from '#/utils/process/resolve-command';

export const INVALID_TUI_CONFIG_MESSAGE =
  'Invalid TUI config in ~/.kimi-code/tui.toml; using defaults.';

const TRUE_BOOLEAN_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_BOOLEAN_ENV_VALUES = new Set(['0', 'false', 'no', 'off']);

function parseBooleanEnvValue(raw: string | undefined): boolean | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) return undefined;
  if (TRUE_BOOLEAN_ENV_VALUES.has(normalized)) return true;
  if (FALSE_BOOLEAN_ENV_VALUES.has(normalized)) return false;
  return undefined;
}

export type TuiModeFallbackReason = 'tmux_cc' | 'termux' | 'dumb_term';

export interface TuiModeResolution {
  readonly mode: TuiMode;
  readonly config: TuiMode | 'unset';
  readonly fallback?: TuiModeFallbackReason;
  readonly overriddenByEnv?: boolean;
}

export type TmuxControlModeProbe = (env: Readonly<Record<string, string | undefined>>) => boolean;

const TMUX_CONTROL_MODE_TIMEOUT_MS = 2_000;

function queryTmuxControlMode(env: Readonly<Record<string, string | undefined>>): boolean {
  if (process.platform === 'win32') return false;
  const tmuxPath = resolveCommandPath('tmux');
  if (tmuxPath === undefined) return false;
  try {
    const output = execFileSync(tmuxPath, ['display-message', '-p', '#{client_control_mode}'], {
      encoding: 'utf8',
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: TMUX_CONTROL_MODE_TIMEOUT_MS,
    });
    return output.trim() === '1';
  } catch {
    return false;
  }
}

export function detectTuiModeFallback(
  env: Readonly<Record<string, string | undefined>> = process.env,
  probeTmuxControlMode: TmuxControlModeProbe = queryTmuxControlMode,
): TuiModeFallbackReason | undefined {
  const term = (env['TERM'] ?? '').trim().toLowerCase();
  if (term === 'dumb') return 'dumb_term';
  if ((env['TERMUX_VERSION'] ?? '').trim().length > 0) return 'termux';
  if ((env['TMUX'] ?? '').trim().length > 0) {
    if (
      (env['TERM_PROGRAM'] === 'iTerm.app' || env['LC_TERMINAL'] === 'iTerm2') &&
      !term.startsWith('screen') &&
      !term.startsWith('tmux')
    ) {
      return 'tmux_cc';
    }
    if (probeTmuxControlMode(env)) {
      return 'tmux_cc';
    }
  }
  return undefined;
}

export function resolveTuiMode(
  configuredMode?: TuiMode,
  env: Readonly<Record<string, string | undefined>> = process.env,
  probeTmuxControlMode: TmuxControlModeProbe = queryTmuxControlMode,
): TuiModeResolution {
  const config: TuiMode | 'unset' = configuredMode ?? 'unset';
  const envOverride = parseBooleanEnvValue(env['KIMI_CODE_TUI_FULL_SCREEN']);
  if (envOverride !== undefined) {
    return { mode: envOverride ? 'fullscreen' : 'regular', config, overriddenByEnv: true };
  }
  const preferred: TuiMode =
    configuredMode ??
    (parseBooleanEnvValue(env['KIMI_CODE_EXPERIMENTAL_FLAG']) === true ? 'fullscreen' : 'regular');
  if (preferred === 'fullscreen') {
    const fallback = detectTuiModeFallback(env, probeTmuxControlMode);
    if (fallback !== undefined) {
      return { mode: 'regular', config, fallback };
    }
  }
  return { mode: preferred, config };
}

export interface AnimationFrameRateResolution {
  readonly fps?: number;
  readonly warning?: string;
}

export function resolveAnimationFrameRate(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AnimationFrameRateResolution {
  const value = env['KIMI_CODE_TUI_ANIMATION_FPS']?.trim();
  if (value === undefined || value.length === 0) return {};
  const fps = Number(value);
  if (/^\d+$/.test(value) && fps >= 1 && fps <= MAX_ANIMATION_FRAME_RATE) return { fps };
  return {
    warning: `Ignored KIMI_CODE_TUI_ANIMATION_FPS=${JSON.stringify(value)}: expected a whole number from 1 to ${String(MAX_ANIMATION_FRAME_RATE)}.`,
  };
}

export const TuiThemeSchema = z.string();

export const NotificationConditionSchema = z.enum(['unfocused', 'always']);

export const NotificationsConfigSchema = z.object({
  enabled: z.boolean(),
  condition: NotificationConditionSchema,
});

export const UpgradePreferencesSchema = z.object({
  autoInstall: z.boolean(),
});

export const STATUS_LINE_ITEMS = ['mode', 'goal', 'model', 'tasks', 'environment', 'cwd', 'git', 'tips'] as const;
export type StatusLineItem = (typeof STATUS_LINE_ITEMS)[number];

export const StatusLineFileConfigSchema = z.object({
  items: z.array(z.string()).optional(),
  command: z.string().optional(),
});

export const StatusLineConfigSchema = z.object({
  /** Ordered built-in slots for footer line 1; null means the default layout. */
  items: z.array(z.enum(STATUS_LINE_ITEMS)).nullable(),
  /** User command whose first stdout line replaces footer line 1; null disables. */
  command: z.string().nullable(),
});
export type StatusLineConfig = z.infer<typeof StatusLineConfigSchema>;

export const DEFAULT_STATUS_LINE_CONFIG: StatusLineConfig = {
  items: null,
  command: null,
};

export const MarkdownConfigSchema = z.object({
  mermaid: z.enum(['off', 'final']),
});
export type MarkdownConfig = z.infer<typeof MarkdownConfigSchema>;

export const DEFAULT_MARKDOWN_CONFIG: MarkdownConfig = {
  mermaid: 'final',
};

export const ToolCallDensitySchema = z.enum(['compact', 'balanced', 'detailed', 'ungrouped']);
export const ThinkingDisplaySchema = z.enum(['grouped', 'ungrouped']);
export const TranscriptConfigSchema = z.object({
  toolCallDensity: ToolCallDensitySchema,
  thinking: ThinkingDisplaySchema,
});
export type ToolCallDensity = z.infer<typeof ToolCallDensitySchema>;
export type ThinkingDisplay = z.infer<typeof ThinkingDisplaySchema>;
export type TranscriptConfig = z.infer<typeof TranscriptConfigSchema>;

export const DEFAULT_TRANSCRIPT_CONFIG: TranscriptConfig = {
  toolCallDensity: 'compact',
  thinking: 'grouped',
};

export type ToolFolding = 'all' | 'readonly' | 'none';

export interface ToolCallDensityRule {
  readonly folding: ToolFolding;
  readonly unfolded: 'card' | 'row';
}

export const DENSITY: Readonly<Record<ToolCallDensity, ToolCallDensityRule>> = {
  compact: { folding: 'all', unfolded: 'row' },
  balanced: { folding: 'readonly', unfolded: 'row' },
  detailed: { folding: 'readonly', unfolded: 'card' },
  ungrouped: { folding: 'none', unfolded: 'card' },
};

export interface TranscriptPresentationOptions extends TranscriptConfig {
  readonly fullscreen: boolean;
}

export function transcriptGroupingActive(options: TranscriptPresentationOptions): boolean {
  return options.fullscreen &&
    (DENSITY[options.toolCallDensity].folding !== 'none' || options.thinking === 'grouped');
}

export const TuiModeSchema = z.enum(['regular', 'fullscreen']);
export type TuiMode = z.infer<typeof TuiModeSchema>;

export const FollowUpBehaviorSchema = z.enum(['queue', 'steer']);
export type FollowUpBehavior = z.infer<typeof FollowUpBehaviorSchema>;
export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = 'queue';

export type FollowUpDelivery = 'default' | 'steer-draft';

export function resolveFollowUpBehavior(value: FollowUpBehavior | undefined): FollowUpBehavior {
  return value ?? DEFAULT_FOLLOW_UP_BEHAVIOR;
}

export const TuiConfigFileSchema = z.object({
  theme: TuiThemeSchema.optional(),
  tui_mode: z.string().optional(),
  copy_on_select: z.boolean().optional(),
  render_latex: z.boolean().optional(),
  disable_paste_burst: z.boolean().optional(),
  cache_expiry_hint: z.boolean().optional(),
  disable_feedback_survey: z.boolean().optional(),
  auto_session_title: z.boolean().optional(),
  follow_up_behavior: z.unknown().optional(),
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
  status_line: StatusLineFileConfigSchema.optional(),
  markdown: z
    .object({
      mermaid: z.string().optional(),
    })
    .optional(),
  transcript: z
    .object({
      tool_call_density: z.unknown().optional(),
      thinking: z.unknown().optional(),
    })
    .optional(),
});

export const TuiConfigSchema = z.object({
  theme: TuiThemeSchema,
  tuiMode: TuiModeSchema.optional(),
  copyOnSelect: z.boolean().optional(),
  /** LaTeX math rendering in Markdown; optional only so older hand-built test
   * fixtures still typecheck. */
  renderLatex: z.boolean().optional(),
  disablePasteBurst: z.boolean(),
  /** Present in every normalized config; optional only so hand-built test
   * fixtures from before this field existed still typecheck. */
  cacheExpiryHint: z.boolean().optional(),
  disableFeedbackSurvey: z.boolean().optional(),
  /** Present in every normalized config; optional only so hand-built test
   * fixtures from before this field existed still typecheck. */
  autoSessionTitle: z.boolean().optional(),
  followUpBehavior: FollowUpBehaviorSchema.optional(),
  editorCommand: z.string().nullable(),
  notifications: NotificationsConfigSchema,
  upgrade: UpgradePreferencesSchema,
  /** Present in every normalized config; optional only so hand-built test
   * fixtures from before this field existed still typecheck. */
  statusLine: StatusLineConfigSchema.optional(),
  /** Present in every normalized config; optional only so hand-built test
   * fixtures from before this field existed still typecheck. */
  markdown: MarkdownConfigSchema.optional(),
  transcript: TranscriptConfigSchema,
});

export type TuiConfigFileShape = z.infer<typeof TuiConfigFileSchema>;
export type TuiConfig = z.infer<typeof TuiConfigSchema>;
export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;
export type UpgradePreferences = z.infer<typeof UpgradePreferencesSchema>;

export const DEFAULT_NOTIFICATIONS_CONFIG: NotificationsConfig = {
  enabled: true,
  condition: 'unfocused',
};

export const DEFAULT_UPGRADE_PREFERENCES: UpgradePreferences = {
  autoInstall: true,
};

export const DEFAULT_TUI_CONFIG: TuiConfig = TuiConfigSchema.parse({
  theme: 'auto',
  copyOnSelect: true,
  renderLatex: true,
  disablePasteBurst: false,
  cacheExpiryHint: true,
  autoSessionTitle: true,
  editorCommand: null,
  notifications: DEFAULT_NOTIFICATIONS_CONFIG,
  upgrade: DEFAULT_UPGRADE_PREFERENCES,
  statusLine: DEFAULT_STATUS_LINE_CONFIG,
  markdown: DEFAULT_MARKDOWN_CONFIG,
  transcript: DEFAULT_TRANSCRIPT_CONFIG,
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

export async function loadTuiConfig(
  filePath: string = getTuiConfigPath(),
  warn?: (message: string) => void,
): Promise<TuiConfig> {
  if (!existsSync(filePath)) {
    try {
      await saveTuiConfig(DEFAULT_TUI_CONFIG, filePath);
    } catch {
      warn?.('[tui.toml] could not save the default config');
    }
    return DEFAULT_TUI_CONFIG;
  }

  try {
    const text = await readFile(filePath, 'utf-8');
    const shape = parseTuiConfigShape(text);
    return normalizeTuiConfig(shape, warn);
  } catch {
    throw new TuiConfigParseError(DEFAULT_TUI_CONFIG);
  }
}

function parseTuiConfigShape(tomlText: string): TuiConfigFileShape {
  const raw = tomlText.trim().length === 0 ? {} : (parseToml(tomlText) as Record<string, unknown>);
  return TuiConfigFileSchema.parse(raw);
}

export function parseTuiConfig(
  tomlText: string,
  warn?: (message: string) => void,
): TuiConfig {
  return normalizeTuiConfig(parseTuiConfigShape(tomlText), warn);
}

export async function saveTuiConfig(
  config: TuiConfig,
  filePath: string = getTuiConfigPath(),
): Promise<void> {
  let legacyValue = config.disableFeedbackSurvey;
  if (legacyValue === undefined && existsSync(filePath)) {
    const source = await readFile(filePath, 'utf-8');
    try {
      const value = parseToml(source)['disable_feedback_survey'];
      if (typeof value === 'boolean') legacyValue = value;
    } catch {
      legacyValue = undefined;
    }
  }
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, renderTuiConfig({
    ...config,
    disableFeedbackSurvey: legacyValue,
  }), 'utf-8');
}

export async function removeLegacySurveySetting(filePath: string = getTuiConfigPath()): Promise<void> {
  const lines = (await readFile(filePath, 'utf-8')).split('\n');
  let inTable = false;
  let removed = false;
  const kept = lines.filter((line) => {
    if (/^\s*\[/.test(line)) inTable = true;
    if (!inTable && /^\s*["']?disable_feedback_survey["']?\s*=/.test(line)) {
      removed = true;
      return false;
    }
    return true;
  });
  if (!removed) return;
  await writeFile(filePath, kept.join('\n'), 'utf-8');
}

export function normalizeTuiConfig(
  config: TuiConfigFileShape,
  warn: (message: string) => void = (message) => {
    // oxlint-disable-next-line no-console
    console.warn(message);
  },
): TuiConfig {
  const command = config.editor?.command?.trim();
  const statusLineCommand = config.status_line?.command?.trim();
  const knownItems = new Set<string>(STATUS_LINE_ITEMS);
  const statusLineItems =
    config.status_line?.items
      ?.filter((item) => {
        const known = knownItems.has(item);
        if (!known) {
          warn(`[tui.toml] ignoring unknown status_line item: ${item}`);
        }
        return known;
      })
      .map((item) => item as StatusLineItem) ?? null;
  const mermaidValue = config.markdown?.mermaid;
  let mermaidMode: MermaidRenderMode = DEFAULT_MARKDOWN_CONFIG.mermaid;
  if (mermaidValue !== undefined) {
    if (mermaidValue === 'off' || mermaidValue === 'final') {
      mermaidMode = mermaidValue;
    } else {
      warn(`[tui.toml] ignoring unknown markdown.mermaid value: ${mermaidValue}`);
    }
  }
  const transcriptValue = <T>(key: string, schema: z.ZodType<T>, value: unknown, fallback: T): T => {
    if (value === undefined) return fallback;
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    const shown = typeof value === 'string' ? value : JSON.stringify(value);
    warn(`[tui.toml] ignoring unknown transcript.${key} value: ${shown}`);
    return fallback;
  };
  const followUpValue = config.follow_up_behavior;
  let followUpBehavior: FollowUpBehavior | undefined;
  if (followUpValue !== undefined) {
    const parsed = FollowUpBehaviorSchema.safeParse(followUpValue);
    if (parsed.success) {
      followUpBehavior = parsed.data;
    } else {
      const shown = typeof followUpValue === 'string' ? followUpValue : JSON.stringify(followUpValue);
      warn(`[tui.toml] ignoring unknown follow_up_behavior value: ${shown}`);
    }
  }
  const tuiModeValue = config.tui_mode;
  let tuiMode: TuiMode | undefined;
  if (tuiModeValue !== undefined) {
    if (tuiModeValue === 'regular' || tuiModeValue === 'fullscreen') {
      tuiMode = tuiModeValue;
    } else {
      warn(`[tui.toml] ignoring unknown tui_mode value: ${tuiModeValue}`);
    }
  }
  return TuiConfigSchema.parse({
    theme: config.theme ?? DEFAULT_TUI_CONFIG.theme,
    tuiMode,
    copyOnSelect:
      config.copy_on_select ?? DEFAULT_TUI_CONFIG.copyOnSelect,
    renderLatex: config.render_latex ?? DEFAULT_TUI_CONFIG.renderLatex,
    disablePasteBurst: config.disable_paste_burst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
    cacheExpiryHint: config.cache_expiry_hint ?? DEFAULT_TUI_CONFIG.cacheExpiryHint,
    disableFeedbackSurvey: config.disable_feedback_survey,
    autoSessionTitle: config.auto_session_title ?? DEFAULT_TUI_CONFIG.autoSessionTitle,
    followUpBehavior,
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
      items: statusLineItems,
      command:
        statusLineCommand === undefined || statusLineCommand.length === 0
          ? null
          : statusLineCommand,
    },
    markdown: {
      mermaid: mermaidMode,
    },
    transcript: {
      toolCallDensity: transcriptValue(
        'tool_call_density',
        ToolCallDensitySchema,
        config.transcript?.tool_call_density,
        DEFAULT_TRANSCRIPT_CONFIG.toolCallDensity,
      ),
      thinking: transcriptValue(
        'thinking',
        ThinkingDisplaySchema,
        config.transcript?.thinking,
        DEFAULT_TRANSCRIPT_CONFIG.thinking,
      ),
    },
  });
}

export function renderTuiConfig(config: TuiConfig): string {
  // An active status_line must round-trip: any preference save rewrites the
  // whole file, so the section is emitted live when set and left as a
  // commented-out guide when unset. The [markdown] section follows the same
  // pattern: live when mermaid rendering is turned off, commented guide at
  // the default.
  const statusItems = config.statusLine?.items;
  const statusCommand = config.statusLine?.command;
  const statusLines: string[] = [];
  if (statusItems !== null && statusItems !== undefined) {
    statusLines.push(`items = ${JSON.stringify(statusItems)}`);
  }
  if (statusCommand) {
    statusLines.push(`command = "${escapeTomlBasicString(statusCommand)}"`);
  }
  const followUpLine = `follow_up_behavior = "${resolveFollowUpBehavior(config.followUpBehavior)}" # "queue" | "steer"`;
  const tuiModeLine =
    config.tuiMode === undefined
      ? '# tui_mode = "regular" # "regular" | "fullscreen" ("fullscreen" is experimental)'
      : `tui_mode = "${config.tuiMode}" # "regular" | "fullscreen" ("fullscreen" is experimental)`;
  const markdownSection =
    config.markdown?.mermaid === 'off'
      ? `[markdown]\nmermaid = "off" # "final" | "off"\n`
      : `# [markdown]
# Draw mermaid code blocks as diagrams in the terminal; "off" keeps highlighted source.
# mermaid = "final" # "final" | "off"
`;
  const transcript = config.transcript;
  const densityLine = `tool_call_density = "${transcript.toolCallDensity}" # "compact" | "balanced" | "detailed"`;
  const thinkingLine = `thinking = "${transcript.thinking}" # "grouped" | "ungrouped"`;
  const transcriptSection =
    transcript.toolCallDensity === DEFAULT_TRANSCRIPT_CONFIG.toolCallDensity &&
    transcript.thinking === DEFAULT_TRANSCRIPT_CONFIG.thinking
      ? `# [transcript]
# Fullscreen transcript display preferences.
# ${densityLine}
# ${thinkingLine}
`
      : `[transcript]\n${densityLine}\n${thinkingLine}\n`;
  const statusSection =
    statusLines.length > 0
      ? `[status_line]\n${statusLines.join('\n')}\n`
      : `# [status_line]
# Pick and order the built-in footer slots: ${STATUS_LINE_ITEMS.join(', ')}
# items = ${JSON.stringify([...STATUS_LINE_ITEMS])}
# Or render your own: a command whose first stdout line replaces footer line 1.
# It receives a JSON snapshot (model, cwd, git, usage, mode) on stdin.
# command = "~/.kimi-code/statusline.sh"
`;
  return `# ~/.kimi-code/tui.toml
# Client preferences for kimi-code.
# Agent/runtime settings stay in ~/.kimi-code/config.toml.

theme = "${escapeTomlBasicString(config.theme)}" # "auto" | "dark" | "light" | custom theme name
${tuiModeLine}
copy_on_select = ${String(config.copyOnSelect !== false)} # fullscreen only: false copies only when you press Ctrl-C
render_latex = ${String(config.renderLatex !== false)} # false keeps LaTeX math in assistant messages as raw source
disable_paste_burst = ${String(config.disablePasteBurst)} # true disables non-bracketed paste-burst fallback
cache_expiry_hint = ${String(config.cacheExpiryHint !== false)} # false disables the "cache expired" dialog on resume / idle submit
${config.disableFeedbackSurvey === undefined ? '' : `disable_feedback_survey = ${String(config.disableFeedbackSurvey)}\n`}auto_session_title = ${String(config.autoSessionTitle !== false)} # false stops the TUI from auto-generating a session title after the first turn
${config.followUpBehavior === undefined ? `# ${followUpLine}` : followUpLine}

[editor]
command = "${escapeTomlBasicString(config.editorCommand ?? '')}" # Empty uses $VISUAL / $EDITOR

[notifications]
enabled = ${String(config.notifications.enabled)} # true | false
notification_condition = "${config.notifications.condition}" # "unfocused" | "always"

[upgrade]
auto_install = ${String(config.upgrade.autoInstall)} # true | false

${markdownSection}
${transcriptSection}
${statusSection}`;
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
