// Renderer↔main telemetry contract: the only events the renderer may emit over
// kimi:track. The schema is also the source of the renderer's compile-time
// types, while the main process uses it as the runtime trust boundary. Payloads
// never include user content or paths.

import { z } from 'zod';

import { ACTION_INVOKED_IDS, SHORTCUT_ACTION_IDS } from './action-ids';

const shortStringSchema = z.string().min(1).max(64);
const optionalCappedStringSchema = z.string().max(64).optional().catch(undefined);
const optionalBooleanSchema = z.boolean().optional().catch(undefined);
const optionalDurationSchema = z.number().int().nonnegative().max(3_600_000).optional().catch(undefined);

const settingsSourcePanel = {
  source_panel: z.enum(['settings', 'mobile_settings', 'update_prompt', 'user_menu']).optional().catch(undefined),
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

const settingsChangedPropertiesSchema = z.discriminatedUnion('key', [
  z.object({ key: z.literal('language'), value: z.enum(['en', 'zh']), ...settingsSourcePanel }),
  z.object({ key: z.literal('theme'), value: z.enum(['system', 'light', 'dark']), ...settingsSourcePanel }),
  z.object({ key: z.literal('font-size'), value: z.enum(['small', 'medium', 'large', 'xlarge']), ...settingsSourcePanel }),
  z.object({ key: z.literal('vibrancy'), value: z.enum(['on', 'off']), ...settingsSourcePanel }),
  z.object({ key: z.literal('notifications'), value: z.enum(['on', 'off']), ...settingsSourcePanel }),
  z.object({ key: z.literal('open-in-default'), value: shortStringSchema, ...settingsSourcePanel }),
  z.object({ key: z.literal('dock-icon'), value: z.enum(['light', 'dark', 'auto']), ...settingsSourcePanel }),
  z.object({ key: z.literal('update-auto-download'), value: z.enum(['on', 'off']), ...settingsSourcePanel }),
]);

export const rendererTrackEventSchema = z.discriminatedUnion('event', [
  z.object({
    // Menu-synced actions (openSettings/newSession/openFolder) register native
    // menu accelerators, so their keyboard presses arrive as menu clicks and
    // are attributed to 'menu' — 'shortcut' only covers non-synced actions.
    event: z.literal('action_invoked'),
    properties: z.object({
      action: z.enum(ACTION_INVOKED_IDS),
      source: z.enum(['shortcut', 'menu', 'button']),
    }),
  }),
  z.object({
    event: z.literal('update_prompt_shown'),
    properties: z.object({ version: optionalCappedStringSchema }),
  }),
  z.object({
    event: z.literal('update_prompt_action'),
    properties: z.object({
      action: z.enum(['skip', 'download', 'restart', 'retry']),
      version: optionalCappedStringSchema,
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
      stage: z.enum(['starting', 'device-code', 'success', 'expired', 'error']),
      ok: optionalBooleanSchema,
      method: z.enum(['oauth', 'api_key', 'none']),
      duration_ms: optionalDurationSchema,
      error_class: z.enum(['start_failed', 'poll_failed', 'expired', 'cancelled']).optional().catch(undefined),
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
      fallback: optionalBooleanSchema,
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
      via: z.enum(['button', 'number-key']),
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
        'rename',
        'fork',
        'export',
        'archive',
        'openChanges',
        'openPr',
      ]),
    }),
  }),
  z.object({
    event: z.literal('attachment_added'),
    properties: z.object({
      via: z.enum(['drop', 'click', 'paste']),
      kind: z.enum(['image', 'video', 'file']).optional().catch(undefined),
      size_bucket: z.enum(['<1mb', '1-10mb', '10-50mb', '50mb+']),
      // Batch size, repeated on every event of the batch — NOT summable.
      count: z.number().int().min(1).max(100),
    }),
  }),
  z.object({
    event: z.literal('ui_element_toggled'),
    properties: z.object({
      element: z.enum(['thinking_block', 'tool_call']),
      expanded: z.boolean(),
      // Always 1 today: no sampling yet, the field keeps future sampled
      // events weightable (doc §2.3).
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
    properties: z.object({ error_class: shortStringSchema }),
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
    event: z.literal('workspace_removed'),
    properties: z.object({ workspace_count: z.number().int().nonnegative().max(1000) }),
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
export type OnboardingStepEvent = RendererEventPayloads['onboarding_step'];
export type OauthLoginStepEvent = RendererEventPayloads['oauth_login_step'];
export type ShortcutBindingChangedEvent = RendererEventPayloads['shortcut_binding_changed'];
export type SettingsChangedEvent = RendererEventPayloads['settings_changed'];
export type NativeFeatureUsedEvent = RendererEventPayloads['native_feature_used'];
export type ApprovalDecisionEvent = RendererEventPayloads['approval_decision'];
export type ApprovalDecisionName = ApprovalDecisionEvent['decision'];
export type SessionMenuActionEvent = RendererEventPayloads['session_menu_action'];
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
