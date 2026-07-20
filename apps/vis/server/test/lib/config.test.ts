import { describe, it, expect } from 'vitest';
import { hostForUrl, isAllInterfaces, getLocalNetworkAddresses } from '../../src/config';

describe('hostForUrl', () => {
  it('brackets a bare IPv6 literal for use in a URL', () => {
    expect(hostForUrl('::1')).toBe('[::1]');
  });

  it('leaves an IPv4 literal unchanged', () => {
    expect(hostForUrl('127.0.0.1')).toBe('127.0.0.1');
  });

  it('leaves a hostname unchanged', () => {
    expect(hostForUrl('localhost')).toBe('localhost');
  });

  it('leaves an already-bracketed IPv6 literal unchanged', () => {
    expect(hostForUrl('[::1]')).toBe('[::1]');
  });
});

describe('isAllInterfaces', () => {
  it('returns true for 0.0.0.0', () => {
    expect(isAllInterfaces('0.0.0.0')).toBe(true);
  });

  it('returns true for ::', () => {
    expect(isAllInterfaces('::')).toBe(true);
  });

  it('returns false for loopback hosts', () => {
    expect(isAllInterfaces('127.0.0.1')).toBe(false);
    expect(isAllInterfaces('localhost')).toBe(false);
    expect(isAllInterfaces('::1')).toBe(false);
  });
});

describe('getLocalNetworkAddresses', () => {
  it('returns non-empty array of IPv4 URLs for a valid port', () => {
    const addresses = getLocalNetworkAddresses(3001);
    expect(addresses.length).toBeGreaterThan(0);
    for (const addr of addresses) {
      expect(addr).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:3001\/$/);
    }
  });

  it('returns different URLs for different ports', () => {
    const addrs3001 = getLocalNetworkAddresses(3001);
    const addrs8080 = getLocalNetworkAddresses(8080);
    expect(addrs3001.length).toBe(addrs8080.length);
    for (let i = 0; i < addrs3001.length; i++) {
      expect(addrs3001[i]).toContain(':3001/');
      expect(addrs8080[i]).toContain(':8080/');
    }
  });
});
