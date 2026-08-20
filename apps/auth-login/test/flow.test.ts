import { describe, expect, it } from 'vitest';
import { oauthHostForHostname } from '../src/flow';

describe('oauthHostForHostname', () => {
  it('maps .kimi.ai hosts to the global OAuth host', () => {
    expect(oauthHostForHostname('kimi.ai')).toBe('https://auth.kimi.ai');
    expect(oauthHostForHostname('www.kimi.ai')).toBe('https://auth.kimi.ai');
    expect(oauthHostForHostname('code.kimi.ai')).toBe('https://auth.kimi.ai');
  });

  it('maps everything else to the mainland-China OAuth host', () => {
    expect(oauthHostForHostname('kimi.com')).toBe('https://auth.kimi.com');
    expect(oauthHostForHostname('www.kimi.com')).toBe('https://auth.kimi.com');
    expect(oauthHostForHostname('localhost')).toBe('https://auth.kimi.com');
    expect(oauthHostForHostname('127.0.0.1')).toBe('https://auth.kimi.com');
  });

  it('does not match lookalike suffixes', () => {
    expect(oauthHostForHostname('kimi.ai.evil.example.com')).toBe('https://auth.kimi.com');
    expect(oauthHostForHostname('notkimi.ai')).toBe('https://auth.kimi.com');
  });
});
