/**
 * WS upgrade auth (ROADMAP M3).
 *
 * M3.1 adds the `kimi-code.bearer.<token>` subprotocol parser; M3.2 wires it
 * into the upgrade path. The parser is exercised as pure unit cases here; the
 * upgrade-path cases are added in the M3.2 block below.
 */

import { describe, expect, it } from 'vitest';

import { extractWsBearerToken } from '../src/services/gateway/wsGateway';

describe('extractWsBearerToken', () => {
  it('returns undefined for a missing header', () => {
    expect(extractWsBearerToken(undefined)).toBeUndefined();
  });

  it('returns undefined for an empty header', () => {
    expect(extractWsBearerToken('')).toBeUndefined();
  });

  it('extracts the token from a single bearer subprotocol', () => {
    expect(extractWsBearerToken('kimi-code.bearer.TOKEN')).toBe('TOKEN');
  });

  it('finds the bearer subprotocol among a comma-separated list', () => {
    expect(extractWsBearerToken('other, kimi-code.bearer.TOKEN2')).toBe('TOKEN2');
  });

  it('returns undefined for an empty token', () => {
    expect(extractWsBearerToken('kimi-code.bearer.')).toBeUndefined();
  });

  it('returns undefined when no subprotocol matches', () => {
    expect(extractWsBearerToken('unrelated')).toBeUndefined();
  });
});
