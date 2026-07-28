// Desktop-owned event contracts. Payloads never include user content or paths.
// Renderer-emittable contracts live in src/shared/track-events.ts (shared with
// the renderer for compile-time checking) and are re-exported here so this
// file stays the single readable catalog; the interfaces below are main-only.

import type {
  ActionInvokedEvent,
  ApprovalDecisionEvent,
  AttachmentAddedEvent,
  ConnectionRestoredEvent,
  NativeFeatureUsedEvent,
  NotificationKindEvent,
  OnboardingAbandonedEvent,
  OnboardingCompletedEvent,
  OnboardingStepEvent,
  OauthLoginStepEvent,
  PlanUsageCardViewedEvent,
  RendererErrorEvent,
  SearchExecutedEvent,
  SessionCreatedEvent,
  SessionMenuActionEvent,
  SettingsChangedEvent,
  ShortcutBindingChangedEvent,
  TelemetryConsentChangedEvent,
  UiElementToggledEvent,
  UpdatePromptActionEvent,
  UpdatePromptShownEvent,
  WorkspaceCountEvent,
} from '../shared/track-events';

export type {
  ActionInvokedEvent,
  ApprovalDecisionEvent,
  AttachmentAddedEvent,
  ConnectionRestoredEvent,
  NativeFeatureUsedEvent,
  NotificationKindEvent,
  OnboardingAbandonedEvent,
  OnboardingCompletedEvent,
  OnboardingStepEvent,
  OauthLoginStepEvent,
  PlanUsageCardViewedEvent,
  RendererErrorEvent,
  SearchExecutedEvent,
  SessionCreatedEvent,
  SessionMenuActionEvent,
  SettingsChangedEvent,
  ShortcutBindingChangedEvent,
  TelemetryConsentChangedEvent,
  UiElementToggledEvent,
  UpdatePromptActionEvent,
  UpdatePromptShownEvent,
  WorkspaceCountEvent,
} from '../shared/track-events';

export interface EmbeddedRendererLoadResultEvent {
  ok: boolean;
  duration_ms: number;
  error_class?: string;
}

export interface AppLaunchedEvent {
  // tray/notification activations happen while already running and are covered
  // by tray_action / notification_clicked; a second-instance launch never
  // reaches app ready (single-instance lock).
  launch_intent: 'normal' | 'jump_list';
}

// Cumulative milliseconds since process start (process.uptime()) at each
// startup milestone; renderer_ready is the renderer-subscribed proxy for
// first interactive.
export interface StartupTimingEvent {
  phase: 'main_ready' | 'window_shown' | 'renderer_loaded' | 'renderer_ready';
  duration_ms: number;
}

export interface RendererCrashedEvent {
  reason:
    | 'clean-exit'
    | 'abnormal-exit'
    | 'killed'
    | 'crashed'
    | 'oom'
    | 'launch-failed'
    | 'integrity-failure';
  exit_code: number;
}

export interface StartupConnectResultEvent {
  ok: boolean;
  failure_phase?: 'spawn' | 'port' | 'handshake' | 'auth' | 'timeout';
  retry_count?: number;
  error_class?: string;
}

export type StartupFailureScreenShownEvent = Record<string, never>;

export interface AppCrashedEvent {
  process: 'main' | 'gpu';
  kind: string;
  error_name?: string;
  app_uptime_ms: number;
}

export interface UpdateStatusChangedEvent {
  state: 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';
  from_version?: string;
  to_version?: string;
  prev_state?: 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';
  error_class?: string;
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
  // Absent on 'shown'; 'deactivate' covers minimize.
  reason?: 'quit' | 'close_to_tray' | 'deactivate';
  // Absent on 'shown'; visible time since the last 'shown'.
  visible_duration_ms?: number;
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
  window_count: number;
}

export interface DesktopEventPayloads {
  embedded_renderer_load_result: EmbeddedRendererLoadResultEvent;
  app_launched: AppLaunchedEvent;
  startup_timing: StartupTimingEvent;
  startup_connect_result: StartupConnectResultEvent;
  startup_failure_screen_shown: StartupFailureScreenShownEvent;
  app_crashed: AppCrashedEvent;
  renderer_crashed: RendererCrashedEvent;
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
  onboarding_completed: OnboardingCompletedEvent;
  onboarding_abandoned: OnboardingAbandonedEvent;
  oauth_login_step: OauthLoginStepEvent;
  shortcut_binding_changed: ShortcutBindingChangedEvent;
  settings_changed: SettingsChangedEvent;
  native_feature_used: NativeFeatureUsedEvent;
  approval_decision: ApprovalDecisionEvent;
  session_menu_action: SessionMenuActionEvent;
  session_created: SessionCreatedEvent;
  attachment_added: AttachmentAddedEvent;
  ui_element_toggled: UiElementToggledEvent;
  notification_shown: NotificationKindEvent;
  notification_clicked: NotificationKindEvent;
  search_opened: Record<string, never>;
  search_executed: SearchExecutedEvent;
  logout: Record<string, never>;
  plan_usage_card_viewed: PlanUsageCardViewedEvent;
  telemetry_consent_changed: TelemetryConsentChangedEvent;
  renderer_error: RendererErrorEvent;
  connection_lost: Record<string, never>;
  connection_restored: ConnectionRestoredEvent;
  workspace_added: WorkspaceCountEvent;
  workspace_removed: WorkspaceCountEvent;
}

export type DesktopEventName = keyof DesktopEventPayloads;
