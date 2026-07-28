// Renderer↔main telemetry contract: the only events the renderer may emit over
// the kimi:track IPC. Shared as types so a renderer-side typo fails at compile
// time instead of being dropped silently by the main-process whitelist
// (main/track.ts), which stays the runtime trust boundary. Payloads never
// include user content or paths.

export interface ActionInvokedEvent {
  action: string;
  source: 'shortcut' | 'menu' | 'button' | 'tray';
}

export interface UpdatePromptShownEvent {
  version?: string;
}

export interface UpdatePromptActionEvent {
  action: 'skip' | 'download' | 'restart' | 'retry';
  version?: string;
}

export interface OnboardingStepEvent {
  step: string;
  skipped?: boolean;
}

export interface OauthLoginStepEvent {
  stage: string;
  ok?: boolean;
}

export interface ShortcutBindingChangedEvent {
  action: string;
  op: 'assign' | 'reset' | 'clear' | 'reset_all';
  had_conflict?: boolean;
}

// `value` stays enum-like (theme names, locales, app ids, booleans) — never
// free text; the IPC whitelist caps its length.
export interface SettingsChangedEvent {
  key: string;
  value?: string;
}

export interface NativeFeatureUsedEvent {
  feature: string;
  fallback?: boolean;
}

export interface ApprovalDecisionEvent {
  decision: string;
  via: 'button' | 'number-key';
}

export interface SessionMenuActionEvent {
  action: string;
}

export interface AttachmentAddedEvent {
  via: 'drop' | 'click' | 'paste';
  kind?: string;
}

export interface UiElementToggledEvent {
  element: string;
  expanded: boolean;
}

export interface RendererEventPayloads {
  action_invoked: ActionInvokedEvent;
  update_prompt_shown: UpdatePromptShownEvent;
  update_prompt_action: UpdatePromptActionEvent;
  onboarding_step: OnboardingStepEvent;
  oauth_login_step: OauthLoginStepEvent;
  shortcut_binding_changed: ShortcutBindingChangedEvent;
  settings_changed: SettingsChangedEvent;
  native_feature_used: NativeFeatureUsedEvent;
  approval_decision: ApprovalDecisionEvent;
  session_menu_action: SessionMenuActionEvent;
  attachment_added: AttachmentAddedEvent;
  ui_element_toggled: UiElementToggledEvent;
}

export type RendererEventName = keyof RendererEventPayloads;

export type RendererTrackEvent = {
  [K in RendererEventName]: { event: K; properties: RendererEventPayloads[K] };
}[RendererEventName];
