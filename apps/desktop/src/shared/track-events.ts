
import { z } from 'zod';

import { ACTION_INVOKED_IDS, SHORTCUT_ACTION_IDS } from './action-ids';

const shortStringSchema = z.string().min(1).max(64);

const clampedCountSchema = z.number().int().nonnegative().transform((value) => Math.min(value, 1_000_000));
const clampedPerfMsSchema = z.number().int().nonnegative().transform((value) => Math.min(value, 86_400_000));

const optionalCappedStringSchema = z.string().max(64).optional().catch(undefined);
const optionalBooleanSchema = z.boolean().optional().catch(undefined);
const optionalDurationSchema = z.number().int().nonnegative().max(3_600_000).optional().catch(undefined);

const settingsSourcePanel = {
  source_panel: z.enum(['settings', 'mobile_settings', 'update_prompt', 'user_menu']).optional().catch(undefined),
};

const forcedUpgradeProperties = {
  client: z.literal('desktop'),
  current_version: shortStringSchema,
  minimum_version: shortStringSchema,
  target_version: optionalCappedStringSchema,
  channel: z.enum(['stable', 'canary']),
};

const shortcutBindingChangedPropertiesSchema = z.discriminatedUnion('op', [
  z.object({
    action: z.enum(SHORTCUT_ACTION_IDS),
    op: z.enum(['assign', 'reset', 'clear']),
    had_conflict: optionalBooleanSchema,
  }),
  z.object({
    action: z.literal('*'),
    op: z.literal('reset_all'),
    had_conflict: optionalBooleanSchema,
  }),
]);

const fontModeSchema = z.enum(['same', 'system', 'kimi', 'custom']);

const settingsChangedPropertiesSchema = z.discriminatedUnion('key', [
  z.object({ key: z.literal('language'), value: z.enum(['en', 'zh']), ...settingsSourcePanel }),
  z.object({ key: z.literal('theme'), value: z.enum(['system', 'light', 'dark']), ...settingsSourcePanel }),
  z.object({ key: z.literal('font-size'), value: z.enum(['small', 'medium', 'large', 'xlarge']), ...settingsSourcePanel }),
  z.object({ key: z.literal('vibrancy'), value: z.enum(['on', 'off']), ...settingsSourcePanel }),
  z.object({ key: z.literal('prevent-system-sleep'), value: z.enum(['allow-sleep', 'prevent-app-suspension', 'prevent-display-sleep']), ...settingsSourcePanel }),
  z.object({ key: z.literal('prevent-lid-sleep'), value: z.enum(['on', 'off']), ...settingsSourcePanel }),
  z.object({ key: z.literal('notifications'), value: z.enum(['on', 'off']), ...settingsSourcePanel }),
  z.object({ key: z.literal('open-in-default'), value: shortStringSchema, ...settingsSourcePanel }),
  z.object({ key: z.literal('dock-icon'), value: z.enum(['light', 'dark']), ...settingsSourcePanel }),
  z.object({ key: z.literal('sidebar-multi-tab'), value: z.enum(['on', 'off']), ...settingsSourcePanel }),
  z.object({ key: z.literal('session-mentions'), value: z.enum(['on', 'off']), ...settingsSourcePanel }),
  z.object({ key: z.literal('native-title-bar'), value: z.enum(['on', 'off']), ...settingsSourcePanel }),
  z.object({ key: z.literal('update-auto-download'), value: z.enum(['on', 'off']), ...settingsSourcePanel }),
  z.object({ key: z.literal('browser-autoplay'), value: z.enum(['allow', 'block']), ...settingsSourcePanel }),
  z.object({ key: z.literal('browser-sound'), value: z.enum(['on', 'muted']), ...settingsSourcePanel }),
  z.object({ key: z.literal('browser-agent-control'), value: z.enum(['on', 'off']), ...settingsSourcePanel }),
  z.object({ key: z.literal('browser-subagent-control'), value: z.enum(['on', 'off']), ...settingsSourcePanel }),
  z.object({ key: z.literal('browser-search-engine'), value: z.enum(['google', 'bing', 'duckduckgo', 'baidu']), ...settingsSourcePanel }),
  z.object({ key: z.literal('browser-ask-where-to-save'), value: z.enum(['on', 'off']), ...settingsSourcePanel }),
  z.object({ key: z.literal('browser-agent-download-location'), value: z.enum(['default', 'custom']), ...settingsSourcePanel }),
  z.object({ key: z.literal('browser-agent-download-limit'), value: z.enum(['100mb', '500mb', '1gb', '5gb', 'unlimited']), ...settingsSourcePanel }),
  z.object({ key: z.literal('browser-default-zoom'), value: z.enum(['75', '90', '100', '110', '125', '150']), ...settingsSourcePanel }),
  z.object({ key: z.literal('browser-user-agent'), value: z.enum(['default', 'custom']), ...settingsSourcePanel }),
  z.object({ key: z.literal('browser-user-agent-presets'), value: z.enum(['added', 'removed']), ...settingsSourcePanel }),
  z.object({ key: z.literal('font-ui'), value: fontModeSchema, ...settingsSourcePanel }),
  z.object({ key: z.literal('font-transcript'), value: fontModeSchema, ...settingsSourcePanel }),
  z.object({ key: z.literal('font-code'), value: fontModeSchema, ...settingsSourcePanel }),
  z.object({ key: z.literal('font-terminal'), value: fontModeSchema, ...settingsSourcePanel }),
  z.object({ key: z.literal('font-terminal-size'), value: z.union([z.literal('default'), z.string().regex(/^(9|[12]\d|3[0-2])$/)]), ...settingsSourcePanel }),
  z.object({ key: z.literal('running-send-mode'), value: z.enum(['steer', 'queue']), ...settingsSourcePanel }),
  z.object({
    key: z.literal('browser-tab-title'),
    value: z.enum(['workspace-session', 'session-workspace', 'workspace', 'session', 'none']),
    ...settingsSourcePanel,
  }),
]);

export const rendererTrackEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('action_invoked'),
    properties: z.object({
      action: z.enum(ACTION_INVOKED_IDS),
      source: z.enum(['shortcut', 'menu', 'button']),
    }),
  }),
  z.object({
    event: z.literal('update_prompt_shown'),
    properties: z.object({
      version: optionalCappedStringSchema,
      channel: z.enum(['stable', 'canary']).optional().catch(undefined),
    }),
  }),
  z.object({
    event: z.literal('update_prompt_action'),
    properties: z.object({
      action: z.enum(['skip', 'download', 'restart', 'retry', 'open-installer']),
      version: optionalCappedStringSchema,
      channel: z.enum(['stable', 'canary']).optional().catch(undefined),
    }),
  }),
  z.object({
    event: z.literal('forced_upgrade_prompt_shown'),
    properties: z.object(forcedUpgradeProperties),
  }),
  z.object({
    event: z.literal('forced_upgrade_action'),
    properties: z.object({
      ...forcedUpgradeProperties,
      action: z.enum(['upgrade', 'skip', 'retry', 'restart']),
      trigger: z.enum(['initial', 'error']),
      attempt: z.number().int().nonnegative(),
      waited_ms: optionalDurationSchema,
      error_stage: z.enum(['check', 'download', 'install']).optional().catch(undefined),
    }),
  }),
  z.object({
    event: z.literal('forced_upgrade_state_changed'),
    properties: z.object({
      ...forcedUpgradeProperties,
      from_state: z.enum(['idle', 'prompt', 'checking', 'downloading', 'downloaded', 'installing', 'error', 'skipped']),
      to_state: z.enum(['checking', 'downloading', 'downloaded', 'installing', 'error']),
      error_stage: z.enum(['check', 'download', 'install']).optional().catch(undefined),
      error_class: optionalCappedStringSchema,
      attempt: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    event: z.literal('occupied_prompt_shown'),
    properties: z.object({
      holder_client: optionalCappedStringSchema,
      opener_client: z.enum(['web', 'desktop']),
    }),
  }),
  z.object({
    event: z.literal('occupied_choice'),
    properties: z.object({
      choice: z.enum(['retry', 'takeover', 'cancel']),
    }),
  }),
  z.object({
    event: z.literal('session_stale_shown'),
    properties: z.object({
      opener_client: z.enum(['web', 'desktop']),
    }),
  }),
  z.object({
    event: z.literal('onboarding_step'),
    properties: z.object({
      step: z.enum(['preferences', 'login']),
      skipped: optionalBooleanSchema,
      step_index: z.number().int().nonnegative(),
      total_steps: z.number().int().min(1),
      duration_ms: optionalDurationSchema,
    }),
  }),
  z.object({
    event: z.literal('onboarding_completed'),
    properties: z.object({
      total_duration_ms: z.number().int().nonnegative().max(3_600_000),
    }),
  }),
  z.object({
    event: z.literal('onboarding_abandoned'),
    properties: z.object({
      last_step: z.enum(['preferences', 'login']),
      total_duration_ms: z.number().int().nonnegative().max(3_600_000),
    }),
  }),
  z.object({
    event: z.literal('oauth_login_step'),
    properties: z.object({
      stage: z.enum(['starting', 'device-code', 'success', 'denied', 'expired', 'error']),
      ok: optionalBooleanSchema,
      method: z.enum(['oauth', 'api_key', 'none']),
      duration_ms: optionalDurationSchema,
      error_class: z.enum(['start_failed', 'poll_failed', 'expired', 'cancelled', 'denied']).optional().catch(undefined),
    }),
  }),
  z.object({
    event: z.literal('shortcut_binding_changed'),
    properties: shortcutBindingChangedPropertiesSchema,
  }),
  z.object({
    event: z.literal('settings_changed'),
    properties: settingsChangedPropertiesSchema,
  }),
  z.object({
    event: z.literal('native_feature_used'),
    properties: z.object({
      feature: z.enum(['workspace_drop', 'workspace_picker', 'open_in']),
    }),
  }),
  z.object({
    event: z.literal('approval_decision'),
    properties: z.object({
      decision: z.enum([
        'approve',
        'approveSession',
        'reject',
        'approvePlan',
        'approveOption',
        'revisePlan',
        'rejectAndExit',
      ]),
      via: z.enum(['button', 'number-key', 'shortcut-key']),
      request_id: optionalCappedStringSchema,
    }),
  }),
  z.object({
    event: z.literal('session_menu_action'),
    properties: z.object({
      action: z.enum([
        'copyAll',
        'copyFinalSummary',
        'copySessionId',
        'pin',
        'unpin',
        'rename',
        'fork',
        'export',
        'archive',
        'restore',
        'reload',
        'openChanges',
        'openPr',
        'togglePanel',
      ]),
    }),
  }),
  z.object({
    event: z.literal('session_reload_result'),
    properties: z.object({
      result: z.enum(['success', 'busy', 'archived', 'error']),
    }),
  }),
  z.object({
    event: z.literal('session_emoji_changed'),
    properties: z.object({
      action: z.enum(['set', 'remove', 'random']),
      via: z.enum(['menu', 'icon']),
    }),
  }),
  z.object({
    event: z.literal('attachment_added'),
    properties: z.object({
      via: z.enum(['drop', 'click', 'paste']),
      kind: z.enum(['image', 'video', 'file']).optional().catch(undefined),
      size_bucket: z.enum(['<1mb', '1-10mb', '10-50mb', '50mb+']),
      count: z.number().int().min(1).max(100),
    }),
  }),
  z.object({
    event: z.literal('ui_element_toggled'),
    properties: z.object({
      element: z.enum(['thinking_block', 'tool_call']),
      expanded: z.boolean(),
      sample_rate: z.literal(1),
    }),
  }),
  z.object({
    event: z.literal('session_created'),
    properties: z.object({
      kind: z.enum(['new', 'resumed']),
      source: z.enum([
        'sidebar',
        'shortcut',
        'menu',
        'jump_list',
        'tray',
        'notification',
        'search',
        'slash_command',
      ]),
    }),
  }),
  z.object({
    event: z.literal('notification_shown'),
    properties: z.object({ kind: z.enum(['turn_complete', 'question', 'approval']) }),
  }),
  z.object({
    event: z.literal('notification_clicked'),
    properties: z.object({ kind: z.enum(['turn_complete', 'question', 'approval']) }),
  }),
  z.object({
    event: z.literal('search_opened'),
    properties: z.object({}),
  }),
  z.object({
    event: z.literal('search_executed'),
    properties: z.object({
      scope: z.literal('current_session'),
      result_count_bucket: z.enum(['0', '1-10', '11-50', '50+']),
    }),
  }),
  z.object({
    event: z.literal('logout'),
    properties: z.object({}),
  }),
  z.object({
    event: z.literal('plan_usage_card_viewed'),
    properties: z.object({ usage_bucket: z.enum(['ok', 'warn', 'danger']) }),
  }),
  z.object({
    event: z.literal('upgrade_clicked'),
    properties: z.object({}),
  }),
  z.object({
    event: z.literal('telemetry_consent_changed'),
    properties: z.object({ enabled: z.boolean() }),
  }),
  z.object({
    event: z.literal('renderer_error'),
    properties: z.object({
      error_class: shortStringSchema,
      source: z.enum(['window', 'rejection', 'vue']).optional(),
      fingerprint: shortStringSchema.optional(),
      top_frame: shortStringSchema.optional(),
      phase: z.enum(['boot', 'running']).optional(),
    }),
  }),
  z.object({
    event: z.literal('connection_lost'),
    properties: z.object({}),
  }),
  z.object({
    event: z.literal('connection_restored'),
    properties: z.object({ duration_ms: z.number().int().nonnegative().max(86_400_000) }),
  }),
  z.object({
    event: z.literal('workspace_added'),
    properties: z.object({ workspace_count: z.number().int().nonnegative().max(1000) }),
  }),
  z.object({
    event: z.literal('workspace_created'),
    properties: z.object({ roots_count: z.number().int().min(1).max(64) }),
  }),
  z.object({
    event: z.literal('workspace_dir_added'),
    properties: z.object({ source: z.enum(['registry', 'project-config']) }),
  }),
  z.object({
    event: z.literal('workspace_dir_removed'),
    properties: z.object({ source: z.enum(['registry', 'project-config']) }),
  }),
  z.object({
    event: z.literal('workspace_removed'),
    properties: z.object({
      workspace_count: z.number().int().nonnegative().max(1000),
      kind: z.enum(['wd', 'wm']),
    }),
  }),
  z.object({
    event: z.literal('file_tree_root_switched'),
    properties: z.object({}),
  }),
  z.object({
    event: z.literal('remote_control_action'),
    properties: z.discriminatedUnion('action', [
      z.object({
        action: z.literal('enable'),
        outcome: z.enum(['ok', 'error', 'conflict', 'login_required']),
      }),
      z.object({ action: z.literal('disable'), outcome: z.enum(['ok', 'error']) }),
      z.object({ action: z.literal('takeover'), outcome: z.enum(['ok', 'error', 'cancelled']) }),
      z.object({
        action: z.literal('copy_link'),
        source: z.enum(['panel', 'conflict_dialog']),
        outcome: z.enum(['ok', 'error']),
      }),
      z.object({ action: z.literal('open_link'), source: z.enum(['panel', 'conflict_dialog']) }),
      z.object({ action: z.literal('refresh_devices') }),
      z.object({ action: z.literal('rename'), outcome: z.enum(['ok', 'error', 'cancelled']) }),
      z.object({
        action: z.literal('deactivate'),
        outcome: z.enum(['ok', 'error', 'cancelled']),
        target: z.enum(['current_device', 'other_device']),
      }),
      z.object({
        action: z.literal('delete'),
        outcome: z.enum(['ok', 'error', 'cancelled']),
        target: z.enum(['current_device', 'other_device']),
      }),
    ]),
  }),
  z.object({
    event: z.literal('session_busy_longtasks'),
    properties: z.object({
      session_id: shortStringSchema,
      longtask_count: clampedCountSchema,
      longtask_total_ms: clampedPerfMsSchema,
      longtask_max_ms: clampedPerfMsSchema,
      busy_duration_ms: clampedPerfMsSchema,
    }),
  }),
  z.object({
    event: z.literal('session_open_timing'),
    properties: z.object({
      session_id: shortStringSchema,
      duration_ms: clampedPerfMsSchema,
      cached: z.boolean(),
    }),
  }),
]);

export type RendererTrackEvent = z.infer<typeof rendererTrackEventSchema>;
export type RendererEventName = RendererTrackEvent['event'];
export type RendererEventPayloads = {
  [Event in RendererTrackEvent as Event['event']]: Event['properties'];
};

export type ActionInvokedEvent = RendererEventPayloads['action_invoked'];
export type UpdatePromptShownEvent = RendererEventPayloads['update_prompt_shown'];
export type UpdatePromptActionEvent = RendererEventPayloads['update_prompt_action'];
export type OccupiedPromptShownEvent = RendererEventPayloads['occupied_prompt_shown'];
export type OccupiedChoiceEvent = RendererEventPayloads['occupied_choice'];
export type SessionStaleShownEvent = RendererEventPayloads['session_stale_shown'];
export type OnboardingStepEvent = RendererEventPayloads['onboarding_step'];
export type OauthLoginStepEvent = RendererEventPayloads['oauth_login_step'];
export type ShortcutBindingChangedEvent = RendererEventPayloads['shortcut_binding_changed'];
export type SettingsChangedEvent = RendererEventPayloads['settings_changed'];
export type NativeFeatureUsedEvent = RendererEventPayloads['native_feature_used'];
export type ApprovalDecisionEvent = RendererEventPayloads['approval_decision'];
export type ApprovalDecisionName = ApprovalDecisionEvent['decision'];
export type SessionMenuActionEvent = RendererEventPayloads['session_menu_action'];
export type SessionReloadResultEvent = RendererEventPayloads['session_reload_result'];
export type SessionEmojiChangedEvent = RendererEventPayloads['session_emoji_changed'];
export type AttachmentAddedEvent = RendererEventPayloads['attachment_added'];
export type UiElementToggledEvent = RendererEventPayloads['ui_element_toggled'];
export type SessionCreatedEvent = RendererEventPayloads['session_created'];
export type SessionCreatedSource = SessionCreatedEvent['source'];
export type NotificationKindEvent = RendererEventPayloads['notification_shown'];
export type OnboardingCompletedEvent = RendererEventPayloads['onboarding_completed'];
export type OnboardingAbandonedEvent = RendererEventPayloads['onboarding_abandoned'];
export type SearchExecutedEvent = RendererEventPayloads['search_executed'];
export type PlanUsageCardViewedEvent = RendererEventPayloads['plan_usage_card_viewed'];
export type TelemetryConsentChangedEvent = RendererEventPayloads['telemetry_consent_changed'];
export type RendererErrorEvent = RendererEventPayloads['renderer_error'];
export type ConnectionRestoredEvent = RendererEventPayloads['connection_restored'];
export type WorkspaceCountEvent = RendererEventPayloads['workspace_added'];
export type WorkspaceCreatedEvent = RendererEventPayloads['workspace_created'];
export type WorkspaceDirChangedEvent = RendererEventPayloads['workspace_dir_added'];
export type WorkspaceRemovedEvent = RendererEventPayloads['workspace_removed'];
export type RemoteControlActionEvent = RendererEventPayloads['remote_control_action'];
export type SessionBusyLongtasksEvent = RendererEventPayloads['session_busy_longtasks'];
export type SessionOpenTimingEvent = RendererEventPayloads['session_open_timing'];
