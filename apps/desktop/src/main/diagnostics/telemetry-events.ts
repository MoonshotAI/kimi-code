
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
  OccupiedChoiceEvent,
  OccupiedPromptShownEvent,
  PlanUsageCardViewedEvent,
  RemoteControlActionEvent,
  RendererErrorEvent,
  RendererEventPayloads,
  SearchExecutedEvent,
  SessionCreatedEvent,
  SessionEmojiChangedEvent,
  SessionBusyLongtasksEvent,
  SessionMenuActionEvent,
  SessionOpenTimingEvent,
  SessionReloadResultEvent,
  SessionStaleShownEvent,
  SettingsChangedEvent,
  ShortcutBindingChangedEvent,
  TelemetryConsentChangedEvent,
  UiElementToggledEvent,
  UpdatePromptActionEvent,
  UpdatePromptShownEvent,
  WorkspaceCountEvent,
  WorkspaceCreatedEvent,
  WorkspaceDirChangedEvent,
  WorkspaceRemovedEvent,
} from '../../shared/track-events';
import type { BrowserErrorCode, BrowserOperation } from '../../shared/browser-automation';

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
  OccupiedChoiceEvent,
  OccupiedPromptShownEvent,
  PlanUsageCardViewedEvent,
  RemoteControlActionEvent,
  RendererErrorEvent,
  SearchExecutedEvent,
  SessionCreatedEvent,
  SessionEmojiChangedEvent,
  SessionBusyLongtasksEvent,
  SessionMenuActionEvent,
  SessionOpenTimingEvent,
  SessionReloadResultEvent,
  SessionStaleShownEvent,
  SettingsChangedEvent,
  ShortcutBindingChangedEvent,
  TelemetryConsentChangedEvent,
  UiElementToggledEvent,
  UpdatePromptActionEvent,
  UpdatePromptShownEvent,
  WorkspaceCountEvent,
  WorkspaceCreatedEvent,
  WorkspaceDirChangedEvent,
  WorkspaceRemovedEvent,
} from '../../shared/track-events';

export interface EmbeddedRendererLoadResultEvent {
  ok: boolean;
  duration_ms: number;
  error_class?: string;
}

export interface AppLaunchedEvent {
  launch_intent: 'normal' | 'jump_list';
}

export interface StartupTimingEvent {
  phase: 'main_ready' | 'window_shown' | 'renderer_loaded' | 'renderer_ready' | 'ui_mounted' | 'ui_ready';
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

export interface StartupWebAssetsWaitEvent {
  outcome: 'appeared' | 'timeout' | 'aborted';
  waited_ms: number;
}

export interface AppCrashedEvent {
  process: 'main' | 'gpu';
  kind: string;
  error_name?: string;
  app_uptime_ms: number;
  fingerprint?: string;
  top_frame?: string;
}

export interface WhiteScreenSuspectedEvent {
  kind: 'startup_stalled' | 'not_mounted' | 'boot_stalled' | 'unresponsive' | 'renderer_gone';
  stage: string;
  elapsed_ms: number;
}

export interface PreviousLaunchAbnormalEvent {
  last_stage: string;
  uptime_ms: number;
  version_changed: boolean;
  renderer_gone: boolean;
  main_exception: boolean;
  previous_launch_id: string;
}

export interface UpdateStatusChangedEvent {
  state: 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';
  from_version?: string;
  to_version?: string;
  prev_state?: 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';
  error_class?: string;
}

export interface MenuActionEvent {
  action: 'check-for-updates' | 'help-docs' | 'help-console' | 'export-diagnostics' | 'open-logs-folder';
}

export interface TrayActionEvent {
  action: 'open-session' | 'show-window' | 'quit' | 'export-diagnostics' | 'open-logs-folder';
  pending_count?: number;
}

export interface GlobalShortcutInvokedEvent {
  action: 'summonApp' | 'captureScreenshot';
}

export interface QuitConfirmationEvent {
  action: 'shown' | 'quit' | 'cancel';
}

export interface UpdateSessionContinueEvent {
  outcome: 'armed' | 'not_updated' | 'expired' | 'attempted';
  session_count: number;
  continued_count?: number;
}

export interface GlobalShortcutRegisterFailedEvent {
  action: 'summonApp' | 'captureScreenshot';
  reason: 'invalid' | 'conflicted';
}

export interface WindowLifecycleEvent {
  action: 'shown' | 'hidden' | 'closed';
  reason?: 'quit' | 'close_to_tray' | 'deactivate';
  visible_duration_ms?: number;
}

export interface NativeIpcUsedEvent {
  channel: 'dialog-open' | 'dialog-save' | 'open-in' | 'show-window' | 'hide-window' | 'vibrancy' | 'prevent-system-sleep' | 'prevent-lid-sleep' | 'linux-native-titlebar';
}

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
  session_count?: number;
}

export type BrowserOperationErrorCode =
  | BrowserErrorCode
  | 'CONTROL_DISABLED'
  | 'INVALID_ARGS'
  | 'SUBAGENT_RUN_INVALID'
  | 'UNKNOWN_TOOL';

export interface BrowserOperationResultEvent {
  operation: BrowserOperation | 'unknown';
  ok: boolean;
  error_code?: BrowserOperationErrorCode;
  duration_ms: number;
  caller: 'main' | 'subagent';
  session_id?: string;
}

export type BrowserControlTrigger = 'input' | 'control_ui' | 'ipc' | 'new_turn' | 'overlay_failure';

export interface BrowserControlChangedEvent {
  action: 'user_takeover' | 'auto_takeover' | 'handback' | 'subagent_revoked' | 'subagent_restored';
  trigger: BrowserControlTrigger;
  session_id?: string;
}

export interface BrowserMcpReconnectEvent {
  reason: 'session_create' | 'setting_change';
  retried: boolean;
  ok: boolean;
  session_id?: string;
}

export interface DesktopEventPayloads {
  embedded_renderer_load_result: EmbeddedRendererLoadResultEvent;
  app_launched: AppLaunchedEvent;
  startup_timing: StartupTimingEvent;
  startup_connect_result: StartupConnectResultEvent;
  startup_failure_screen_shown: StartupFailureScreenShownEvent;
  startup_web_assets_wait: StartupWebAssetsWaitEvent;
  app_crashed: AppCrashedEvent;
  white_screen_suspected: WhiteScreenSuspectedEvent;
  previous_launch_abnormal: PreviousLaunchAbnormalEvent;
  renderer_crashed: RendererCrashedEvent;
  update_status_changed: UpdateStatusChangedEvent;
  action_invoked: ActionInvokedEvent;
  update_prompt_shown: UpdatePromptShownEvent;
  update_prompt_action: UpdatePromptActionEvent;
  forced_upgrade_prompt_shown: RendererEventPayloads['forced_upgrade_prompt_shown'];
  forced_upgrade_action: RendererEventPayloads['forced_upgrade_action'];
  forced_upgrade_state_changed: RendererEventPayloads['forced_upgrade_state_changed'];
  occupied_prompt_shown: OccupiedPromptShownEvent;
  occupied_choice: OccupiedChoiceEvent;
  session_stale_shown: SessionStaleShownEvent;
  menu_action: MenuActionEvent;
  tray_action: TrayActionEvent;
  quit_confirmation: QuitConfirmationEvent;
  update_session_continue: UpdateSessionContinueEvent;
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
  session_reload_result: SessionReloadResultEvent;
  session_emoji_changed: SessionEmojiChangedEvent;
  session_created: SessionCreatedEvent;
  attachment_added: AttachmentAddedEvent;
  ui_element_toggled: UiElementToggledEvent;
  notification_shown: NotificationKindEvent;
  notification_clicked: NotificationKindEvent;
  search_opened: Record<string, never>;
  search_executed: SearchExecutedEvent;
  logout: Record<string, never>;
  plan_usage_card_viewed: PlanUsageCardViewedEvent;
  upgrade_clicked: Record<string, never>;
  telemetry_consent_changed: TelemetryConsentChangedEvent;
  renderer_error: RendererErrorEvent;
  connection_lost: Record<string, never>;
  connection_restored: ConnectionRestoredEvent;
  workspace_added: WorkspaceCountEvent;
  workspace_created: WorkspaceCreatedEvent;
  workspace_dir_added: WorkspaceDirChangedEvent;
  workspace_dir_removed: WorkspaceDirChangedEvent;
  workspace_removed: WorkspaceRemovedEvent;
  file_tree_root_switched: Record<string, never>;
  remote_control_action: RemoteControlActionEvent;
  session_busy_longtasks: SessionBusyLongtasksEvent;
  session_open_timing: SessionOpenTimingEvent;
  prediction_shown: RendererEventPayloads['prediction_shown'];
  prediction_accepted: RendererEventPayloads['prediction_accepted'];
  prediction_submitted: RendererEventPayloads['prediction_submitted'];
  prediction_dismissed: RendererEventPayloads['prediction_dismissed'];
  browser_operation_result: BrowserOperationResultEvent;
  browser_control_changed: BrowserControlChangedEvent;
  browser_mcp_reconnect: BrowserMcpReconnectEvent;
}

export type DesktopEventName = keyof DesktopEventPayloads;
