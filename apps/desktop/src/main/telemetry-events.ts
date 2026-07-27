// Desktop-owned telemetry event contracts — the catalog of everything the
// desktop host reports. Local on purpose, NOT in agent-core-v2's shared
// registry (events.ts): kimi-code is a public repo and the desktop app is
// unreleased — registering host events there (tray, native menu, updater…)
// would publish the product surface ahead of release. Emission goes through
// the untyped `ITelemetryService.track` (see track.ts), whose wire format is
// identical to the registry-typed `track2`, so upstreaming this file later
// is a mechanical move + a one-line switch.
//
// Same conventions as the shared registry: snake_case event and property
// names, durations/counts carry `_ms`/`_count` suffixes, and never user
// content or file paths.

export interface StartupConnectResultEvent {
  mode: 'embedded' | 'external';
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

// Curated user-initiated IPC channels only (channel without the `kimi:`
// prefix); sync/poll channels would drown the signal.
export interface NativeIpcUsedEvent {
  channel: string;
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

export interface DesktopEventPayloads {
  startup_connect_result: StartupConnectResultEvent;
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
