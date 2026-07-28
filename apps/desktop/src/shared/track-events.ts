// Renderer↔main telemetry contract: the only events the renderer may emit over
// kimi:track. The schema is also the source of the renderer's compile-time
// types, while the main process uses it as the runtime trust boundary. Payloads
// never include user content or paths.

import { z } from 'zod';

const shortStringSchema = z.string().min(1).max(64);
const optionalCappedStringSchema = z.string().max(64).optional().catch(undefined);
const optionalShortStringSchema = shortStringSchema.optional().catch(undefined);
const optionalBooleanSchema = z.boolean().optional().catch(undefined);

export const rendererTrackEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('action_invoked'),
    properties: z.object({
      action: shortStringSchema,
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
      step: shortStringSchema,
      skipped: optionalBooleanSchema,
    }),
  }),
  z.object({
    event: z.literal('oauth_login_step'),
    properties: z.object({
      stage: shortStringSchema,
      ok: optionalBooleanSchema,
    }),
  }),
  z.object({
    event: z.literal('shortcut_binding_changed'),
    properties: z.object({
      action: shortStringSchema,
      op: z.enum(['assign', 'reset', 'clear', 'reset_all']),
      had_conflict: optionalBooleanSchema,
    }),
  }),
  z.object({
    event: z.literal('settings_changed'),
    properties: z.object({
      key: shortStringSchema,
      value: optionalShortStringSchema,
    }),
  }),
  z.object({
    event: z.literal('native_feature_used'),
    properties: z.object({
      feature: shortStringSchema,
      fallback: optionalBooleanSchema,
    }),
  }),
  z.object({
    event: z.literal('approval_decision'),
    properties: z.object({
      decision: shortStringSchema,
      via: z.enum(['button', 'number-key']),
    }),
  }),
  z.object({
    event: z.literal('session_menu_action'),
    properties: z.object({ action: shortStringSchema }),
  }),
  z.object({
    event: z.literal('attachment_added'),
    properties: z.object({
      via: z.enum(['drop', 'click', 'paste']),
      kind: optionalShortStringSchema,
    }),
  }),
  z.object({
    event: z.literal('ui_element_toggled'),
    properties: z.object({
      element: shortStringSchema,
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
export type SessionMenuActionEvent = RendererEventPayloads['session_menu_action'];
export type AttachmentAddedEvent = RendererEventPayloads['attachment_added'];
export type UiElementToggledEvent = RendererEventPayloads['ui_element_toggled'];
