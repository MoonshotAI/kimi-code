import { describe, expect, it } from 'vitest';
import { linkUrlParts, registeredDomain } from './linkUrl';

describe('registeredDomain', () => {
  it('returns the host itself when it has at most two labels', () => {
    expect(registeredDomain('example.com')).toBe('example.com');
    expect(registeredDomain('localhost')).toBe('localhost');
  });

  it('strips subdomains down to the last two labels for regular TLDs', () => {
    expect(registeredDomain('sub.example.com')).toBe('example.com');
    expect(registeredDomain('a.b.c.example.org')).toBe('example.org');
    expect(registeredDomain('deep.sub.github.io')).toBe('github.io');
  });

  it('keeps three labels for common second-level suffixes under a two-letter TLD', () => {
    expect(registeredDomain('sub.example.co.uk')).toBe('example.co.uk');
    expect(registeredDomain('example.com.cn')).toBe('example.com.cn');
    expect(registeredDomain('www.example.ac.jp')).toBe('example.ac.jp');
    expect(registeredDomain('service.example.gov.au')).toBe('example.gov.au');
  });

  it('does not treat a two-letter TLD alone as a second-level suffix trigger', () => {
    expect(registeredDomain('sub.example.io')).toBe('example.io');
    expect(registeredDomain('sub.example.dev')).toBe('example.dev');
  });

  it('returns IP literal hosts unchanged', () => {
    expect(registeredDomain('192.168.0.1')).toBe('192.168.0.1');
    expect(registeredDomain('[::1]')).toBe('[::1]');
  });
});

describe('linkUrlParts', () => {
  it('splits a plain https URL around the registered domain', () => {
    expect(linkUrlParts('https://example.com/path?q=1#top')).toEqual({
      leading: 'https://',
      domain: 'example.com',
      trailing: '/path?q=1#top',
    });
  });

  it('keeps subdomains in the leading part', () => {
    expect(linkUrlParts('https://sub.example.co.uk/path')).toEqual({
      leading: 'https://sub.',
      domain: 'example.co.uk',
      trailing: '/path',
    });
  });

  it('round-trips the browser-normalized href through leading + domain + trailing', () => {
    const hrefs = [
      'https://sub.example.co.uk/a/b?x=1&y=2#frag',
      'http://user:pass@deep.sub.example.com:8443/p',
      'https://example.com',
      'https://192.168.1.20:3000/dashboard',
      'http://[2001:db8::1]:8080/v6',
      'https://localhost:5174/app',
      'https://example.com./fqdn',
    ];
    for (const href of hrefs) {
      const parts = linkUrlParts(href);
      expect(parts).not.toBeNull();
      expect(`${parts!.leading}${parts!.domain}${parts!.trailing}`).toBe(new URL(href).href);
    }
  });

  it('highlights the host the browser actually navigates to for backslash userinfo tricks', () => {
    const parts = linkUrlParts('https://evil.example\\@trusted.com/');
    expect(parts).not.toBeNull();
    expect(parts!.domain).toBe('evil.example');
    expect(`${parts!.leading}${parts!.domain}${parts!.trailing}`).toBe(
      'https://evil.example/@trusted.com/',
    );
  });

  it('splits trailing-dot FQDN hosts around the registered domain', () => {
    expect(linkUrlParts('https://example.com./x')).toEqual({
      leading: 'https://',
      domain: 'example.com',
      trailing: './x',
    });
    expect(linkUrlParts('https://sub.example.com./x')).toEqual({
      leading: 'https://sub.',
      domain: 'example.com',
      trailing: './x',
    });
  });

  it('keeps userinfo and port outside the domain', () => {
    expect(linkUrlParts('http://user@sub.example.com:8080/')).toEqual({
      leading: 'http://user@sub.',
      domain: 'example.com',
      trailing: ':8080/',
    });
  });

  it('keeps password-only userinfo in the leading part', () => {
    expect(linkUrlParts('https://:pass@example.com/x')).toEqual({
      leading: 'https://:pass@',
      domain: 'example.com',
      trailing: '/x',
    });
  });

  it('marks only the IP literal as the domain for IP hosts', () => {
    expect(linkUrlParts('https://127.0.0.1:58627/api')).toEqual({
      leading: 'https://',
      domain: '127.0.0.1',
      trailing: ':58627/api',
    });
  });

  it('rejects non-http(s) and host-less hrefs', () => {
    expect(linkUrlParts('ftp://example.com/x')).toBeNull();
    expect(linkUrlParts('mailto:user@example.com')).toBeNull();
    expect(linkUrlParts('//example.com/x')).toBeNull();
    expect(linkUrlParts('https://')).toBeNull();
    expect(linkUrlParts('/relative/path')).toBeNull();
    expect(linkUrlParts('kimi-code://skill/deploy')).toBeNull();
  });
});
