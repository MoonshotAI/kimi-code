// Host telemetry facade; it is a no-op unless embedded telemetry is wired.

import type { TelemetryProperties } from '@moonshot-ai/agent-core-v2';

import type {
  ActionInvokedEvent,
  ApprovalDecisionEvent,
  AttachmentAddedEvent,
  DesktopEventName,
  DesktopEventPayloads,
  NativeFeatureUsedEvent,
  OnboardingStepEvent,
  OauthLoginStepEvent,
  SessionMenuActionEvent,
  SettingsChangedEvent,
  ShortcutBindingChangedEvent,
  UiElementToggledEvent,
  UpdatePromptActionEvent,
  UpdatePromptShownEvent,
} from './telemetry-events';

type TrackImpl = (event: string, properties?: TelemetryProperties) => void;

let impl: TrackImpl | null = null;

export function setDesktopTrackImpl(next: TrackImpl | null): void {
  impl = next;
}

export function trackDesktopEvent<K extends DesktopEventName>(
  event: K,
  properties?: DesktopEventPayloads[K],
): void {
  impl?.(event, properties as TelemetryProperties | undefined);
}

// --- kimi:track IPC payloads --------------------------------------------------

// Main-process trust boundary for renderer telemetry.
export type RendererTrackEvent =
  | { event: 'action_invoked'; properties: ActionInvokedEvent }
  | { event: 'update_prompt_shown'; properties: UpdatePromptShownEvent }
  | { event: 'update_prompt_action'; properties: UpdatePromptActionEvent }
  | { event: 'onboarding_step'; properties: OnboardingStepEvent }
  | { event: 'oauth_login_step'; properties: OauthLoginStepEvent }
  | { event: 'shortcut_binding_changed'; properties: ShortcutBindingChangedEvent }
  | { event: 'settings_changed'; properties: SettingsChangedEvent }
  | { event: 'native_feature_used'; properties: NativeFeatureUsedEvent }
  | { event: 'approval_decision'; properties: ApprovalDecisionEvent }
  | { event: 'session_menu_action'; properties: SessionMenuActionEvent }
  | { event: 'attachment_added'; properties: AttachmentAddedEvent }
  | { event: 'ui_element_toggled'; properties: UiElementToggledEvent };

function asShortString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function asRendererTrackEvent(
  event: unknown,
  payload: unknown,
): RendererTrackEvent | null {
  if (
    typeof event !== 'string' ||
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const p = payload as Record<string, unknown>;
  const version =
    typeof p['version'] === 'string' && p['version'].length <= 64 ? p['version'] : undefined;
  switch (event) {
    case 'action_invoked': {
      const action = asShortString(p['action']);
      const source = p['source'];
      if (action === undefined) return null;
      if (source !== 'shortcut' && source !== 'menu' && source !== 'button' && source !== 'tray') {
        return null;
      }
      return { event, properties: { action, source } };
    }
    case 'update_prompt_shown':
      return { event, properties: { version } };
    case 'update_prompt_action': {
      const action = p['action'];
      if (action !== 'skip' && action !== 'download' && action !== 'restart' && action !== 'retry') {
        return null;
      }
      return { event, properties: { action, version } };
    }
    case 'onboarding_step': {
      const step = asShortString(p['step']);
      if (step === undefined) return null;
      return { event, properties: { step, skipped: asOptionalBoolean(p['skipped']) } };
    }
    case 'oauth_login_step': {
      const stage = asShortString(p['stage']);
      if (stage === undefined) return null;
      return { event, properties: { stage, ok: asOptionalBoolean(p['ok']) } };
    }
    case 'shortcut_binding_changed': {
      const action = asShortString(p['action']);
      const op = p['op'];
      if (action === undefined) return null;
      if (op !== 'assign' && op !== 'reset' && op !== 'clear' && op !== 'reset_all') return null;
      return { event, properties: { action, op, had_conflict: asOptionalBoolean(p['had_conflict']) } };
    }
    case 'settings_changed': {
      const key = asShortString(p['key']);
      if (key === undefined) return null;
      return { event, properties: { key, value: asShortString(p['value']) } };
    }
    case 'native_feature_used': {
      const feature = asShortString(p['feature']);
      if (feature === undefined) return null;
      return { event, properties: { feature, fallback: asOptionalBoolean(p['fallback']) } };
    }
    case 'approval_decision': {
      const decision = asShortString(p['decision']);
      const via = p['via'];
      if (decision === undefined) return null;
      if (via !== 'button' && via !== 'number-key') return null;
      return { event, properties: { decision, via } };
    }
    case 'session_menu_action': {
      const action = asShortString(p['action']);
      if (action === undefined) return null;
      return { event, properties: { action } };
    }
    case 'attachment_added': {
      const via = p['via'];
      if (via !== 'drop' && via !== 'click' && via !== 'paste') return null;
      return { event, properties: { via, kind: asShortString(p['kind']) } };
    }
    case 'ui_element_toggled': {
      const element = asShortString(p['element']);
      const expanded = p['expanded'];
      if (element === undefined || typeof expanded !== 'boolean') return null;
      return { event, properties: { element, expanded } };
    }
    default:
      return null;
  }
}
