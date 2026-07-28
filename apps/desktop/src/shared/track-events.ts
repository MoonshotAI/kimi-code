// Renderer↔main telemetry contract: the only events the renderer may emit over
// kimi:track. The schema is also the source of the renderer's compile-time
// types, while the main process uses it as the runtime trust boundary. Payloads
// never include user content or paths.

import { z } from 'zod';

import { ACTION_INVOKED_IDS, SHORTCUT_ACTION_IDS } from './action-ids';

const shortStringSchema = z.string().min(1).max(64);
const optionalCappedStringSchema = z.string().max(64).optional().catch(undefined);
const optionalBooleanSchema = z.boolean().optional().catch(undefined);

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
  z.object({ key: z.literal('language'), value: z.enum(['en', 'zh']) }),
  z.object({ key: z.literal('theme'), value: z.enum(['system', 'light', 'dark']) }),
  z.object({ key: z.literal('font-size'), value: z.enum(['small', 'medium', 'large', 'xlarge']) }),
  z.object({ key: z.literal('vibrancy'), value: z.enum(['on', 'off']) }),
  z.object({ key: z.literal('notifications'), value: z.enum(['on', 'off']) }),
  z.object({ key: z.literal('open-in-default'), value: shortStringSchema }),
  z.object({ key: z.literal('dock-icon'), value: z.enum(['light', 'dark', 'auto']) }),
  z.object({ key: z.literal('update-auto-download'), value: z.enum(['on', 'off']) }),
]);

export const rendererTrackEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('action_invoked'),
    properties: z.object({
      action: z.enum(ACTION_INVOKED_IDS),
      source: z.enum(['shortcut', 'menu', 'button', 'tray']),
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
    }),
  }),
  z.object({
    event: z.literal('oauth_login_step'),
    properties: z.object({
      stage: z.enum(['starting', 'device-code', 'success', 'expired', 'error']),
      ok: optionalBooleanSchema,
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
    }),
  }),
  z.object({
    event: z.literal('ui_element_toggled'),
    properties: z.object({
      element: z.enum(['thinking_block', 'tool_call']),
      expanded: z.boolean(),
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
