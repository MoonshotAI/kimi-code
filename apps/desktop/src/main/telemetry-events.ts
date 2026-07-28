// Desktop-owned event contracts. Payloads never include user content or paths.
// Renderer-emittable contracts live in src/shared/track-events.ts (shared with
// the renderer for compile-time checking) and are re-exported here so this
// file stays the single readable catalog; the interfaces below are main-only.

import type {
  ActionInvokedEvent,
  ApprovalDecisionEvent,
  AttachmentAddedEvent,
  NativeFeatureUsedEvent,
  OnboardingStepEvent,
  OauthLoginStepEvent,
  SessionMenuActionEvent,
  SettingsChangedEvent,
  ShortcutBindingChangedEvent,
  UiElementToggledEvent,
  UpdatePromptActionEvent,
  UpdatePromptShownEvent,
} from '../shared/track-events';

export type {
  ActionInvokedEvent,
  ApprovalDecisionEvent,
  AttachmentAddedEvent,
  NativeFeatureUsedEvent,
  OnboardingStepEvent,
  OauthLoginStepEvent,
  SessionMenuActionEvent,
  SettingsChangedEvent,
  ShortcutBindingChangedEvent,
  UiElementToggledEvent,
  UpdatePromptActionEvent,
  UpdatePromptShownEvent,
} from '../shared/track-events';

export interface EmbeddedRendererLoadResultEvent {
  ok: boolean;
  duration_ms: number;
  error_class?: string;
}

export interface AppCrashedEvent {
  kind: 'uncaught_exception' | 'unhandled_rejection';
  error_name?: string;
}

export interface UpdateStatusChangedEvent {
  state: 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';
  version?: string;
}

// Main-only menu items — items forwarded to the renderer (open-settings,
// new-chat, open-folder, select-all, retry-connection) are already covered by
// the renderer-side action_invoked with source 'menu'; tracking them here
// too would double-count.
export interface MenuActionEvent {
  action: 'check-for-updates' | 'help-docs' | 'help-console';
}

export interface TrayActionEvent {
  action: 'open-session' | 'show-window' | 'quit';
  pending_count?: number;
}

export type GlobalShortcutInvokedEvent = Record<string, never>;

export interface GlobalShortcutRegisterFailedEvent {
  reason: 'invalid' | 'conflicted';
}

export interface WindowLifecycleEvent {
  action: 'shown' | 'hidden' | 'closed';
}

export interface NativeIpcUsedEvent {
  channel: 'dialog-open' | 'dialog-save' | 'open-in' | 'show-window' | 'vibrancy';
}

export interface DesktopEventPayloads {
  embedded_renderer_load_result: EmbeddedRendererLoadResultEvent;
  app_crashed: AppCrashedEvent;
  update_status_changed: UpdateStatusChangedEvent;
  action_invoked: ActionInvokedEvent;
  update_prompt_shown: UpdatePromptShownEvent;
  update_prompt_action: UpdatePromptActionEvent;
  menu_action: MenuActionEvent;
  tray_action: TrayActionEvent;
  global_shortcut_invoked: GlobalShortcutInvokedEvent;
  global_shortcut_register_failed: GlobalShortcutRegisterFailedEvent;
  window_lifecycle: WindowLifecycleEvent;
  native_ipc_used: NativeIpcUsedEvent;
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

export type DesktopEventName = keyof DesktopEventPayloads;
