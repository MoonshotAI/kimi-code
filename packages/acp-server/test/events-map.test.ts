import { describe, expect, it } from 'vitest';

import { isAuthError, isProviderError, turnEndReasonToStopReason } from '../src/events-map';

describe('isAuthError', () => {
  it('matches every code in the auth set', () => {
    expect(isAuthError({ code: 'provider.auth_error' })).toBe(true);
    expect(isAuthError({ code: 'auth.login_required' })).toBe(true);
    expect(isAuthError({ code: 'auth.token_missing' })).toBe(true);
    expect(isAuthError({ code: 'auth.token_unauthorized' })).toBe(true);
    expect(isAuthError({ code: 'auth.provisioning_required' })).toBe(true);
    expect(isAuthError({ code: 'auth.model_not_resolved' })).toBe(true);
  });

  it('does not match provider.* codes that are not auth', () => {
    expect(isAuthError({ code: 'provider.api_error' })).toBe(false);
    expect(isAuthError({ code: 'provider.rate_limit' })).toBe(false);
    expect(isAuthError({ code: 'provider.overloaded' })).toBe(false);
  });

  it('does not match when the error is missing or has no code', () => {
    expect(isAuthError()).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });
});

describe('isProviderError', () => {
  it('matches every code in the provider set', () => {
    expect(isProviderError({ code: 'provider.api_error' })).toBe(true);
    expect(isProviderError({ code: 'provider.rate_limit' })).toBe(true);
    expect(isProviderError({ code: 'provider.connection_error' })).toBe(true);
    expect(isProviderError({ code: 'provider.overloaded' })).toBe(true);
    expect(isProviderError({ code: 'provider.not_found' })).toBe(true);
    expect(isProviderError({ code: 'context.overflow' })).toBe(true);
    expect(isProviderError({ code: 'loop.max_steps_exceeded' })).toBe(true);
  });

  it('does not match auth codes (those are routed through isAuthError)', () => {
    expect(isProviderError({ code: 'provider.auth_error' })).toBe(false);
    expect(isProviderError({ code: 'auth.login_required' })).toBe(false);
  });

  it('does not match provider.filtered — content-filter failures keep the legacy refusal mapping', () => {
    expect(isProviderError({ code: 'provider.filtered' })).toBe(false);
  });

  it('does not match unrelated engine codes', () => {
    expect(isProviderError({ code: 'session.not_found' })).toBe(false);
    expect(isProviderError({ code: 'agent.not_found' })).toBe(false);
    expect(isProviderError({ code: 'turn.agent_busy' })).toBe(false);
  });

  it('does not match when the error is missing or has no code', () => {
    expect(isProviderError()).toBe(false);
    expect(isProviderError(undefined)).toBe(false);
  });
});

describe('turnEndReasonToStopReason', () => {
  it('maps provider.filtered failures to refusal', () => {
    expect(turnEndReasonToStopReason('failed', { code: 'provider.filtered' })).toBe('refusal');
  });

  it('keeps other failures as end_turn (legacy: acp has no failed stop reason)', () => {
    expect(turnEndReasonToStopReason('failed', { code: 'provider.api_error' })).toBe('end_turn');
    expect(turnEndReasonToStopReason('failed', { code: 'provider.overloaded' })).toBe('end_turn');
    expect(turnEndReasonToStopReason('failed', undefined)).toBe('end_turn');
  });

  it('keeps the other reasons unchanged', () => {
    expect(turnEndReasonToStopReason('completed')).toBe('end_turn');
    expect(turnEndReasonToStopReason('cancelled')).toBe('cancelled');
    expect(turnEndReasonToStopReason('blocked')).toBe('refusal');
  });
});