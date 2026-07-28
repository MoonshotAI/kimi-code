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

// Main-process fields mirror the CLI v1 collector (kimi-code
// packages/telemetry system_metrics) so CLI and desktop samples stay
// comparable; the embedded server runs in-process, so its usage is folded
// into the main numbers. Child-process working-set fields are absent when
// Electron provides no per-process memory (Linux); CPU fields are cumulative
// seconds since each process started, absent when the platform reports none.
// Emitted by system-metrics.ts, entirely from the main process.
export interface SystemMetricsEvent {
  process_started_at: number;
  process_uptime_ms: number;
  rss_bytes: number;
  heap_used_bytes: number;
  heap_total_bytes: number;
  external_bytes: number;
  array_buffers_bytes: number;
  cpu_user_us: number;
  cpu_system_us: number;
  cpu_elapsed_us: number;
  load_avg_1m: number;
  free_mem_bytes: number;
  total_mem_bytes: number;
  cpu_count: number;
  constrained_memory_bytes?: number;
  renderer_process_count: number;
  renderer_working_set_bytes?: number;
  gpu_working_set_bytes?: number;
  other_working_set_bytes?: number;
  renderer_cpu_seconds?: number;
  gpu_cpu_seconds?: number;
  other_cpu_seconds?: number;
  renderer_js_heap_used_bytes?: number;
  renderer_js_heap_total_bytes?: number;
  renderer_js_heap_limit_bytes?: number;
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
  system_metrics: SystemMetricsEvent;
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
