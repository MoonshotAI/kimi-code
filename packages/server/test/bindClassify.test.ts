/**
 * `classify(host)` tier classification (ROADMAP M6.1).
 *
 * Pins the loopback / lan / public boundaries that gate every M6 hardening
 * decision, including the wildcard defaults and the RFC1918 / link-local
 * edges (e.g. `172.31.255.255` inside `172.16/12`, `172.32.0.1` just outside).
 */

import { describe, expect, it } from 'vitest';

import { classify } from '../src/services/auth/bindClassify';

describe('classify', () => {
  describe('loopback', () => {
    it.each([
      ['127.0.0.1'],
      ['127.255.255.255'],
      ['::1'],
      ['localhost'],
    ])('%s → loopback', (host) => {
      expect(classify(host)).toBe('loopback');
    });
  });

  describe('lan', () => {
    it.each([
      ['192.168.1.5'],
      ['10.0.0.1'],
      ['172.16.0.1'],
      ['172.31.255.255'],
      ['169.254.1.1'],
      ['fe80::1'],
      ['fe80:0000:0000:0000:0000:0000:0000:0001'],
      ['febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ])('%s → lan', (host) => {
      expect(classify(host)).toBe('lan');
    });
  });

  describe('public', () => {
    it.each([
      ['8.8.8.8'],
      ['172.32.0.1'],
      ['203.0.113.5'],
      ['2001:4860:4860::8888'],
      ['fec0::1'],
      ['example.com'],
    ])('%s → public', (host) => {
      expect(classify(host)).toBe('public');
    });
  });

  describe('wildcard binds default to public unless relaxed', () => {
    it('0.0.0.0 → public by default', () => {
      expect(classify('0.0.0.0')).toBe('public');
    });

    it('0.0.0.0 → lan when bindClass=lan', () => {
      expect(classify('0.0.0.0', { bindClass: 'lan' })).toBe('lan');
    });

    it('0.0.0.0 → public when bindClass=public (explicit)', () => {
      expect(classify('0.0.0.0', { bindClass: 'public' })).toBe('public');
    });

    it(':: → public by default', () => {
      expect(classify('::')).toBe('public');
    });

    it(':: → lan when bindClass=lan', () => {
      expect(classify('::', { bindClass: 'lan' })).toBe('lan');
    });

    it('empty string → public by default', () => {
      expect(classify('')).toBe('public');
    });
  });

  it('bindClass override does not reclassify a concrete loopback/lan host', () => {
    // The override applies only to wildcard binds; a real loopback stays
    // loopback even if a caller passes bindClass=public by mistake.
    expect(classify('127.0.0.1', { bindClass: 'public' })).toBe('loopback');
    expect(classify('192.168.1.5', { bindClass: 'public' })).toBe('lan');
  });
});
