// Desktop telemetry emission point. The CloudAppender lives on the embedded
// server's ITelemetryService (wired by telemetry.ts); this module holds the
// bound track behind a typed facade so other main-process modules — and the
// kimi:track IPC handler — can emit events without touching the server
// handle. No-ops until wired (consent off, wiring failed, or external-server
// mode, where no appender ever exists) and again after shutdown: tracking
// must never break app behavior. Event contracts live in telemetry-events.ts;
// emission uses the untyped `track`, not the registry-typed `track2` (why:
// see telemetry-events.ts).

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

// Events the renderer is allowed to emit. The main process is the trust
// boundary: each payload is re-validated field by field and unknown events or
// properties are dropped, so a compromised or buggy renderer cannot inject
// arbitrary data into the telemetry stream.
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

// Bounded enum-like string; oversized/free-form values are dropped (field
// goes undefined), never truncated.
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
