import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  asRendererTrackEvent,
  setDesktopTrackImpl,
  trackDesktopEvent,
} from '../../src/main/track';

beforeEach(() => {
  setDesktopTrackImpl(null);
});

describe('trackDesktopEvent', () => {
  it('no-ops until an impl is installed', () => {
    expect(() =>
      trackDesktopEvent('embedded_renderer_load_result', { ok: true, duration_ms: 1 }),
    ).not.toThrow();
  });

  it('forwards events to the installed impl', () => {
    const impl = vi.fn();
    setDesktopTrackImpl(impl);
    trackDesktopEvent('app_crashed', {
      process: 'main',
      kind: 'uncaught_exception',
      error_name: 'TypeError',
      app_uptime_ms: 1,
    });
    expect(impl).toHaveBeenCalledWith('app_crashed', {
      process: 'main',
      kind: 'uncaught_exception',
      error_name: 'TypeError',
      app_uptime_ms: 1,
    });
  });

  it('no-ops again once the impl is cleared (shutdown)', () => {
    const impl = vi.fn();
    setDesktopTrackImpl(impl);
    setDesktopTrackImpl(null);
    trackDesktopEvent('app_crashed', {
      process: 'main',
      kind: 'unhandled_rejection',
      app_uptime_ms: 1,
    });
    expect(impl).not.toHaveBeenCalled();
  });

  it('buffers events fired before wiring and replays them in order on install', () => {
    trackDesktopEvent('app_launched', { launch_intent: 'normal' });
    trackDesktopEvent('startup_timing', { phase: 'main_ready', duration_ms: 10 });
    const impl = vi.fn();
    setDesktopTrackImpl(impl);
    expect(impl.mock.calls).toEqual([
      ['app_launched', { launch_intent: 'normal' }],
      ['startup_timing', { phase: 'main_ready', duration_ms: 10 }],
    ]);
    trackDesktopEvent('global_shortcut_invoked', {});
    expect(impl).toHaveBeenCalledTimes(3);
  });

  it('drops the buffered events when wiring never completes (impl cleared)', () => {
    trackDesktopEvent('app_launched', { launch_intent: 'normal' });
    setDesktopTrackImpl(null);
    const impl = vi.fn();
    setDesktopTrackImpl(impl);
    expect(impl).not.toHaveBeenCalled();
  });

  it('keeps only the newest 200 buffered events', () => {
    for (let i = 0; i < 210; i += 1) {
      trackDesktopEvent('startup_timing', { phase: 'main_ready', duration_ms: i });
    }
    const impl = vi.fn();
    setDesktopTrackImpl(impl);
    expect(impl).toHaveBeenCalledTimes(200);
    expect(impl.mock.calls[0]).toEqual([
      'startup_timing',
      { phase: 'main_ready', duration_ms: 10 },
    ]);
  });
});

describe('asRendererTrackEvent', () => {
  it('accepts action_invoked with a valid source', () => {
    expect(
      asRendererTrackEvent('action_invoked', { action: 'newSession', source: 'shortcut' }),
    ).toEqual({ event: 'action_invoked', properties: { action: 'newSession', source: 'shortcut' } });
  });

  it.each(['cmd', '', 'menu;drop', 42])('rejects action_invoked with bad action %j', (action) => {
    expect(asRendererTrackEvent('action_invoked', { action, source: 'menu' })).toBeNull();
  });

  it.each(['keyboard', 'click', '', 1])('rejects action_invoked with bad source %j', (source) => {
    expect(asRendererTrackEvent('action_invoked', { action: 'openSettings', source: source })).toBeNull();
  });

  it('accepts every whitelisted source', () => {
    for (const source of ['shortcut', 'menu', 'button'] as const) {
      expect(
        asRendererTrackEvent('action_invoked', { action: 'openSettings', source }),
      ).toEqual({ event: 'action_invoked', properties: { action: 'openSettings', source } });
    }
  });

  it('accepts update_prompt_shown and strips unknown properties', () => {
    expect(
      asRendererTrackEvent('update_prompt_shown', { version: '1.2.3', note: 'x'.repeat(500) }),
    ).toEqual({ event: 'update_prompt_shown', properties: { version: '1.2.3' } });
  });

  it('accepts update_prompt_shown without a version', () => {
    expect(asRendererTrackEvent('update_prompt_shown', {})).toEqual({
      event: 'update_prompt_shown',
      properties: { version: undefined },
    });
  });

  it.each(['skip', 'download', 'restart', 'retry'] as const)(
    'accepts update_prompt_action %s',
    (action) => {
      expect(asRendererTrackEvent('update_prompt_action', { action, version: '1.2.3' })).toEqual({
        event: 'update_prompt_action',
        properties: { action, version: '1.2.3' },
      });
    },
  );

  it.each(['install', 'close', ''])('rejects update_prompt_action %j', (action) => {
    expect(asRendererTrackEvent('update_prompt_action', { action })).toBeNull();
  });

  it.each([
    ['unknown_event', {}],
    ['exit', { duration_ms: 1 }], // main-only events are not renderer-emittable
    ['action_invoked', null],
    ['action_invoked', 'shortcut'],
    ['action_invoked', ['shortcut']],
    [42, { action: 'x', source: 'menu' }],
  ])('rejects %j with %j', (event, payload) => {
    expect(asRendererTrackEvent(event, payload)).toBeNull();
  });

  it('accepts onboarding_step with optional skipped', () => {
    expect(
      asRendererTrackEvent('onboarding_step', {
        step: 'login',
        skipped: true,
        step_index: 1,
        total_steps: 2,
      }),
    ).toEqual({
      event: 'onboarding_step',
      properties: {
        step: 'login',
        skipped: true,
        step_index: 1,
        total_steps: 2,
        duration_ms: undefined,
      },
    });
    expect(
      asRendererTrackEvent('onboarding_step', { step: 'preferences', step_index: 0, total_steps: 2 }),
    ).toEqual({
      event: 'onboarding_step',
      properties: {
        step: 'preferences',
        skipped: undefined,
        step_index: 0,
        total_steps: 2,
        duration_ms: undefined,
      },
    });
    expect(asRendererTrackEvent('onboarding_step', { step: 'workspace' })).toBeNull();
    // step_index / total_steps are required by the contract.
    expect(asRendererTrackEvent('onboarding_step', { step: 'login' })).toBeNull();
    expect(asRendererTrackEvent('onboarding_step', {})).toBeNull();
  });

  it('accepts oauth_login_step with optional ok', () => {
    expect(
      asRendererTrackEvent('oauth_login_step', { stage: 'starting', ok: false, method: 'oauth' }),
    ).toEqual({
      event: 'oauth_login_step',
      properties: {
        stage: 'starting',
        ok: false,
        method: 'oauth',
        duration_ms: undefined,
        error_class: undefined,
      },
    });
    expect(asRendererTrackEvent('oauth_login_step', { stage: 'polling', method: 'oauth' })).toBeNull();
    // method is required by the contract.
    expect(asRendererTrackEvent('oauth_login_step', { stage: 'starting' })).toBeNull();
    expect(asRendererTrackEvent('oauth_login_step', { ok: true, method: 'oauth' })).toBeNull();
  });

  it('accepts shortcut_binding_changed with a valid op and drops junk flags', () => {
    expect(
      asRendererTrackEvent('shortcut_binding_changed', {
        action: 'summonApp',
        op: 'assign',
        had_conflict: 'yes',
      }),
    ).toEqual({
      event: 'shortcut_binding_changed',
      properties: { action: 'summonApp', op: 'assign', had_conflict: undefined },
    });
    expect(
      asRendererTrackEvent('shortcut_binding_changed', { action: 'summonApp', op: 'rebind' }),
    ).toBeNull();
    expect(
      asRendererTrackEvent('shortcut_binding_changed', { action: 'unknown', op: 'assign' }),
    ).toBeNull();
    expect(
      asRendererTrackEvent('shortcut_binding_changed', { action: '*', op: 'assign' }),
    ).toBeNull();
    expect(
      asRendererTrackEvent('shortcut_binding_changed', { action: '*', op: 'reset_all' }),
    ).toEqual({
      event: 'shortcut_binding_changed',
      properties: { action: '*', op: 'reset_all', had_conflict: undefined },
    });
  });

  it('accepts settings_changed only for known key/value pairs', () => {
    expect(asRendererTrackEvent('settings_changed', { key: 'theme', value: 'dark' })).toEqual({
      event: 'settings_changed',
      properties: { key: 'theme', value: 'dark' },
    });
    expect(asRendererTrackEvent('settings_changed', { key: 'theme', value: 'sepia' })).toBeNull();
    expect(asRendererTrackEvent('settings_changed', { key: 'unknown', value: 'on' })).toBeNull();
    expect(
      asRendererTrackEvent('settings_changed', { key: 'open-in-default', value: 'zed' }),
    ).toEqual({
      event: 'settings_changed',
      properties: { key: 'open-in-default', value: 'zed' },
    });
    expect(
      asRendererTrackEvent('settings_changed', {
        key: 'open-in-default',
        value: 'x'.repeat(65),
      }),
    ).toBeNull();
    expect(asRendererTrackEvent('settings_changed', { value: 'dark' })).toBeNull();
  });

  it('accepts native_feature_used with optional fallback', () => {
    expect(
      asRendererTrackEvent('native_feature_used', { feature: 'workspace_picker', fallback: true }),
    ).toEqual({
      event: 'native_feature_used',
      properties: { feature: 'workspace_picker', fallback: true },
    });
    expect(
      asRendererTrackEvent('native_feature_used', { feature: 'unknown_feature' }),
    ).toBeNull();
    expect(asRendererTrackEvent('native_feature_used', {})).toBeNull();
  });

  it('accepts approval_decision with a valid via', () => {
    expect(
      asRendererTrackEvent('approval_decision', { decision: 'approve', via: 'number-key' }),
    ).toEqual({
      event: 'approval_decision',
      properties: { decision: 'approve', via: 'number-key' },
    });
    expect(
      asRendererTrackEvent('approval_decision', { decision: 'approve', via: 'mouse' }),
    ).toBeNull();
    expect(
      asRendererTrackEvent('approval_decision', { decision: 'custom', via: 'button' }),
    ).toBeNull();
  });

  it('accepts session_menu_action with a known action', () => {
    expect(asRendererTrackEvent('session_menu_action', { action: 'fork' })).toEqual({
      event: 'session_menu_action',
      properties: { action: 'fork' },
    });
    expect(asRendererTrackEvent('session_menu_action', { action: '' })).toBeNull();
    expect(asRendererTrackEvent('session_menu_action', { action: 'custom' })).toBeNull();
  });

  it('accepts attachment_added with a valid via and optional kind', () => {
    expect(
      asRendererTrackEvent('attachment_added', {
        via: 'paste',
        kind: 'image',
        size_bucket: '<1mb',
        count: 1,
      }),
    ).toEqual({
      event: 'attachment_added',
      properties: { via: 'paste', kind: 'image', size_bucket: '<1mb', count: 1 },
    });
    expect(
      asRendererTrackEvent('attachment_added', {
        via: 'paste',
        kind: 'archive',
        size_bucket: '1-10mb',
        count: 2,
      }),
    ).toEqual({
      event: 'attachment_added',
      properties: { via: 'paste', kind: undefined, size_bucket: '1-10mb', count: 2 },
    });
    expect(asRendererTrackEvent('attachment_added', { via: 'api' })).toBeNull();
    // size_bucket / count are required by the contract.
    expect(asRendererTrackEvent('attachment_added', { via: 'paste' })).toBeNull();
  });

  it('accepts ui_element_toggled only with a boolean expanded', () => {
    expect(
      asRendererTrackEvent('ui_element_toggled', {
        element: 'tool_call',
        expanded: false,
        sample_rate: 1,
      }),
    ).toEqual({
      event: 'ui_element_toggled',
      properties: { element: 'tool_call', expanded: false, sample_rate: 1 },
    });
    expect(
      asRendererTrackEvent('ui_element_toggled', {
        element: 'tool_call',
        expanded: 'yes',
        sample_rate: 1,
      }),
    ).toBeNull();
    // sample_rate is a required literal by the contract.
    expect(
      asRendererTrackEvent('ui_element_toggled', { element: 'tool_call', expanded: true }),
    ).toBeNull();
    expect(
      asRendererTrackEvent('ui_element_toggled', {
        element: 'custom',
        expanded: true,
        sample_rate: 1,
      }),
    ).toBeNull();
  });
});
