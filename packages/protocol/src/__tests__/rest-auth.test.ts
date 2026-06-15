import { describe, expect, it } from 'vitest';

import {
  authSummarySchema,
  managedProviderStatusSchema,
  type AuthSummary,
} from '../rest/auth';

describe('authSummarySchema', () => {
  const emptyState: AuthSummary = {
    ready: false,
    providers_count: 0,
    default_model: null,
    managed_provider: null,
  };

  const readyState: AuthSummary = {
    ready: true,
    providers_count: 1,
    default_model: 'kimi-k2',
    managed_provider: {
      name: 'kimi-code-oauth',
      status: 'authenticated',
    },
  };

  it('round-trips an empty (unprovisioned) state', () => {
    const parsed = authSummarySchema.parse(emptyState);
    expect(parsed.ready).toBe(false);
    expect(parsed.providers_count).toBe(0);
    expect(parsed.default_model).toBeNull();
    expect(parsed.managed_provider).toBeNull();
  });

  it('round-trips a ready state with managed provider', () => {
    const parsed = authSummarySchema.parse(readyState);
    expect(parsed.ready).toBe(true);
    expect(parsed.providers_count).toBe(1);
    expect(parsed.default_model).toBe('kimi-k2');
    expect(parsed.managed_provider).toEqual({
      name: 'kimi-code-oauth',
      status: 'authenticated',
    });
  });

  it.each(['authenticated', 'expired', 'revoked', 'unauthenticated'] as const)(
    'accepts managed_provider.status = %s',
    (status) => {
      const parsed = managedProviderStatusSchema.parse(status);
      expect(parsed).toBe(status);
    },
  );

  it('rejects an unknown managed_provider.status', () => {
    const bad = {
      ...readyState,
      managed_provider: { name: 'kimi-code-oauth', status: 'pending' },
    };
    expect(authSummarySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects missing ready', () => {
    const { ready: _omit, ...rest } = emptyState;
    expect(authSummarySchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing providers_count', () => {
    const { providers_count: _omit, ...rest } = emptyState;
    expect(authSummarySchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing default_model', () => {
    const { default_model: _omit, ...rest } = emptyState;
    expect(authSummarySchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing managed_provider', () => {
    const { managed_provider: _omit, ...rest } = emptyState;
    expect(authSummarySchema.safeParse(rest).success).toBe(false);
  });

  it('rejects negative providers_count', () => {
    const bad = { ...emptyState, providers_count: -1 };
    expect(authSummarySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects empty managed_provider.name', () => {
    const bad = {
      ...readyState,
      managed_provider: { name: '', status: 'authenticated' as const },
    };
    expect(authSummarySchema.safeParse(bad).success).toBe(false);
  });
});
