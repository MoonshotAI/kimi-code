import { describe, expect, it } from 'vitest';
import { browserValidators, isBrowserDataSnapshot, isBrowserPreferencesPatch } from '../../../src/shared/browser-data';
import {
  browserTabUserAgentOverride,
  browserUserAgentOverride,
  BROWSER_USER_AGENT_SAVED_PRESETS_MAX,
  browserUserAgentPresetNameError,
  browserUserAgentPresets,
  defaultBrowserUserAgentOverride,
  isBrowserCustomUserAgent,
  isBrowserUserAgentSavedPresets,
  rewriteBrowserRequestHeaders,
  strippedBrowserUserAgent,
} from '../../../src/shared/browser-user-agent';

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.91';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
const ANDROID = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36';

describe('browser user agent validation', () => {
  it.each([
    ['', false],
    ['   ', false],
    ['Bad\nAgent', false],
    ['Bad\r\nAgent', false],
    ['Tab\tAgent', false],
    ['a'.repeat(513), false],
    ['a'.repeat(512), true],
    [CHROME, true],
    [' Leading space ok', true],
  ])('checks %j', (value, expected) => {
    expect(isBrowserCustomUserAgent(value)).toBe(expected);
    expect(isBrowserPreferencesPatch({ customUserAgent: value })).toBe(expected);
  });

  it('accepts null to reset and rejects non-string values in the preference patch', () => {
    expect(isBrowserPreferencesPatch({ customUserAgent: null })).toBe(true);
    expect(isBrowserPreferencesPatch({ customUserAgent: 42 })).toBe(false);
    expect(browserValidators.BrowserPreferencesPatchSchema.Check({ customUserAgent: 'x'.repeat(600) })).toBe(false);
  });

  it('requires the default user agent and a valid custom value in snapshots', () => {
    const preferences = { agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: true, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: CHROME, userAgentPresets: [] };
    expect(isBrowserDataSnapshot({ history: [], preferences, defaultUserAgent: CHROME })).toBe(true);
    expect(isBrowserDataSnapshot({ history: [], preferences })).toBe(false);
    expect(isBrowserDataSnapshot({ history: [], preferences: { ...preferences, customUserAgent: 'a\nb' }, defaultUserAgent: CHROME })).toBe(false);
  });
});

describe('browser user agent saved presets', () => {
  const preset = (name: string, value = CHROME) => ({ name, value });
  const full = Array.from({ length: BROWSER_USER_AGENT_SAVED_PRESETS_MAX }, (_, index) => preset(`Preset ${index}`));

  it('accepts a bounded list of named presets in the preference patch', () => {
    expect(isBrowserPreferencesPatch({ userAgentPresets: [] })).toBe(true);
    expect(isBrowserPreferencesPatch({ userAgentPresets: [preset('Staging'), preset('Mobile', FIREFOX)] })).toBe(true);
    expect(isBrowserPreferencesPatch({ userAgentPresets: full })).toBe(true);
    expect(isBrowserUserAgentSavedPresets(full)).toBe(true);
  });

  it('accepts presets that share a user agent under different names', () => {
    const presets = [preset('Test', FIREFOX), preset('Test 2', FIREFOX)];
    expect(isBrowserPreferencesPatch({ userAgentPresets: presets })).toBe(true);
    expect(browserValidators.BrowserPreferencesPatchSchema.Check({ userAgentPresets: presets })).toBe(true);
    expect(browserUserAgentPresetNameError('Test 2', [preset('Test', FIREFOX)])).toBeNull();
  });

  it.each([
    ['too many presets', [...full, preset('Extra')]],
    ['case-insensitive duplicate names', [preset('Staging'), preset('staging')]],
    ['an empty name', [preset('')]],
    ['a blank name', [preset('   ')]],
    ['a padded name', [preset(' Staging ')]],
    ['a name over 60 characters', [preset('x'.repeat(61))]],
    ['a name with control characters', [preset('a\tb')]],
    ['a user agent with a newline', [preset('Staging', 'a\nb')]],
    ['a user agent over 512 characters', [preset('Staging', 'a'.repeat(513))]],
    ['extra fields', [{ ...preset('Staging'), extra: true }]],
    ['a non-array value', 'Staging'],
  ])('rejects %s', (_label, value) => {
    expect(isBrowserPreferencesPatch({ userAgentPresets: value })).toBe(false);
  });

  it('requires saved presets in snapshots', () => {
    const preferences = { agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: true, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null };
    expect(isBrowserDataSnapshot({ history: [], preferences, defaultUserAgent: CHROME })).toBe(false);
    expect(isBrowserDataSnapshot({ history: [], preferences: { ...preferences, userAgentPresets: [preset('A')] }, defaultUserAgent: CHROME })).toBe(true);
  });

  it('reports name errors for the save form', () => {
    const saved = [preset('Staging')];
    expect(browserUserAgentPresetNameError('  ', saved)).toBe('empty');
    expect(browserUserAgentPresetNameError('x'.repeat(61), saved)).toBe('tooLong');
    expect(browserUserAgentPresetNameError(`  ${'x'.repeat(60)}  `, saved)).toBeNull();
    expect(browserUserAgentPresetNameError(' STAGING ', saved)).toBe('duplicate');
    expect(browserUserAgentPresetNameError('a\u0007b', saved)).toBe('invalid');
    expect(browserUserAgentPresetNameError('Mobile', saved)).toBeNull();
    expect(browserUserAgentPresetNameError('Mobile', full)).toBe('full');
  });
});

describe('browser user agent resolution', () => {
  it.each(['Kimi Code/1.0.0', 'KimiCode/1.0.0', 'KimiCodeCanary/1.0.0-canary.1', 'KimiCodePreview/1.0.0-preview.1'])('strips %s and reduces the Chrome version', (token) => {
    expect(strippedBrowserUserAgent(`Mozilla/5.0 (KHTML, like Gecko) ${token} Chrome/144.0.7559.60 Electron/43.1.1 Safari/537.36 kimi-code-app/1.0.0`))
      .toBe('Mozilla/5.0 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36');
  });

  it('describes the default user agent as Google Chrome with the full version in high-entropy hints', () => {
    const override = defaultBrowserUserAgentOverride('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) KimiCodeCanary/1.0.0 Chrome/144.0.7559.60 Electron/43.1.1 Safari/537.36');
    expect(override.userAgent).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36');
    expect(override.userAgentMetadata?.brands).toContainEqual({ brand: 'Google Chrome', version: '144' });
    expect(override.userAgentMetadata?.fullVersion).toBe('144.0.7559.60');
  });

  it('gives device mode precedence over custom and default values', () => {
    const device = { userAgent: 'Device', platform: 'iPhone' };
    expect(browserTabUserAgentOverride(CHROME, device)).toBe(device);
    expect(browserTabUserAgentOverride(null, device)).toBe(device);
    expect(browserTabUserAgentOverride(null, null)).toBeNull();
    expect(browserTabUserAgentOverride(SAFARI, null)).toEqual({ userAgent: SAFARI });
    expect(browserTabUserAgentOverride(CHROME, null)?.userAgentMetadata?.brands).toBeDefined();
  });

  it('derives Chrome client hints from a Chrome user agent', () => {
    expect(browserUserAgentOverride(CHROME, 'arm')).toEqual({
      userAgent: CHROME,
      platform: 'MacIntel',
      userAgentMetadata: {
        brands: [
          { brand: 'Google Chrome', version: '131' },
          { brand: 'Chromium', version: '131' },
          { brand: 'Not_A Brand', version: '24' },
        ],
        fullVersionList: [
          { brand: 'Google Chrome', version: '131.0.0.0' },
          { brand: 'Chromium', version: '131.0.0.0' },
          { brand: 'Not_A Brand', version: '24.0.0.0' },
        ],
        fullVersion: '131.0.0.0',
        platform: 'macOS',
        platformVersion: '10.15.7',
        architecture: 'arm',
        model: '',
        mobile: false,
        bitness: '64',
        wow64: false,
        formFactors: ['Desktop'],
      },
    });
  });

  it('derives Edge client hints without a Google Chrome brand', () => {
    const metadata = browserUserAgentOverride(EDGE).userAgentMetadata!;
    expect(metadata.brands).toEqual([
      { brand: 'Not_A Brand', version: '8' },
      { brand: 'Chromium', version: '120' },
      { brand: 'Microsoft Edge', version: '120' },
    ]);
    expect(metadata.fullVersionList).toContainEqual({ brand: 'Microsoft Edge', version: '120.0.2210.91' });
    expect(metadata).toMatchObject({ fullVersion: '120.0.2210.91', platform: 'Windows', platformVersion: '10.0.0', architecture: 'x86', bitness: '64' });
    expect(browserUserAgentOverride(EDGE).platform).toBe('Win32');
  });

  it('derives mobile Android hints', () => {
    const override = browserUserAgentOverride(ANDROID);
    expect(override.platform).toBe('Linux armv8l');
    expect(override.userAgentMetadata).toMatchObject({ platform: 'Android', platformVersion: '10', mobile: true, model: '', formFactors: ['Mobile'] });
    expect(override.userAgentMetadata!.brands.map(entry => entry.brand)).toContain('Google Chrome');
  });

  const TAIL = 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  it.each([
    ['X11; Linux x86_64', 'Linux', 'Linux x86_64', 'x86', '64', false],
    ['X11; Ubuntu; Linux x86_64', 'Linux', 'Linux x86_64', 'x86', '64', false],
    ['X11; Linux i686', 'Linux', 'Linux i686', 'x86', '32', false],
    ['X11; Linux i386', 'Linux', 'Linux i386', 'x86', '32', false],
    ['X11; Linux i586', 'Linux', 'Linux i586', 'x86', '32', false],
    ['X11; Linux aarch64', 'Linux', 'Linux aarch64', 'arm', '64', false],
    ['X11; Linux arm64', 'Linux', 'Linux aarch64', 'arm', '64', false],
    ['X11; Linux armv8l', 'Linux', 'Linux armv8l', 'arm', '32', false],
    ['X11; Linux armv7l', 'Linux', 'Linux armv7l', 'arm', '32', false],
    ['X11; Linux armv7', 'Linux', 'Linux armv7', 'arm', '32', false],
    ['X11; Linux armv6l', 'Linux', 'Linux armv6l', 'arm', '32', false],
    ['X11; Linux riscv64', 'Linux', 'Linux riscv64', '', '', false],
    ['X11; Linux ppc64le', 'Linux', 'Linux ppc64le', '', '', false],
    ['X11', 'Linux', 'Linux', '', '', false],
    ['X11; FreeBSD amd64', 'FreeBSD', 'FreeBSD amd64', 'x86', '64', false],
    ['X11; U; FreeBSD i386; en-US', 'FreeBSD', 'FreeBSD i386', 'x86', '32', false],
    ['X11; OpenBSD arm64', 'OpenBSD', 'OpenBSD arm64', 'arm', '64', false],
    ['X11; NetBSD', 'NetBSD', 'NetBSD', '', '', false],
    ['X11; SunOS i86pc', 'SunOS', 'SunOS i86pc', '', '', false],
    ['X11; U; SunOS sun4u; en-US', 'SunOS', 'SunOS sun4u', '', '', false],
    ['X11; AIX ppc64', 'AIX', 'AIX ppc64', '', '', false],
    ['X11; DragonFly x86_64', 'DragonFly', 'DragonFly x86_64', 'x86', '64', false],
    ['Windows NT 10.0; Win64; x64', 'Windows', 'Win32', 'x86', '64', false],
    ['Windows NT 6.1; WOW64', 'Windows', 'Win32', 'x86', '64', true],
    ['Windows NT 10.0', 'Windows', 'Win32', 'x86', '32', false],
    ['Windows NT 10.0; ARM64', 'Windows', 'Win32', 'arm', '64', false],
    ['Windows NT 10.0; Win64; ARM64', 'Windows', 'Win32', 'arm', '64', false],
    ['Windows NT 6.2; ARM', 'Windows', 'Win32', 'arm', '32', false],
    ['X11; CrOS x86_64 14541.0.0', 'Chrome OS', 'Linux x86_64', 'x86', '64', false],
    ['X11; CrOS aarch64 15359.58.0', 'Chrome OS', 'Linux aarch64', 'arm', '64', false],
    ['X11; CrOS armv7l 13597.84.0', 'Chrome OS', 'Linux armv7l', 'arm', '32', false],
  ])('maps the %s platform token', (system, platform, navigatorPlatform, architecture, bitness, wow64) => {
    const override = browserUserAgentOverride(`Mozilla/5.0 (${system}) ${TAIL}`);
    expect(override.platform).toBe(navigatorPlatform);
    expect(override.userAgentMetadata).toMatchObject({ platform, architecture, bitness, wow64 });
  });

  it.each([['x86', 'x86'], ['arm', 'arm']] as const)('uses the %s host architecture for a macOS user agent', (host, architecture) => {
    const override = browserUserAgentOverride(`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${TAIL}`, host);
    expect(override.platform).toBe('MacIntel');
    expect(override.userAgentMetadata).toMatchObject({ platform: 'macOS', architecture, bitness: '64' });
  });

  it('derives client hints for an oversized Chrome major version', () => {
    const userAgent = CHROME.replace(/Chrome\/\d+/, `Chrome/${'9'.repeat(400)}`);
    const metadata = browserUserAgentOverride(userAgent).userAgentMetadata!;
    expect(metadata.brands).toHaveLength(3);
    expect(metadata.brands.map(entry => entry.brand)).toContain('Google Chrome');
  });

  it.each([SAFARI, FIREFOX, 'CustomAgent/1.0', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1'])(
    'omits client hint metadata for non-Chromium user agents: %s',
    (userAgent) => {
      expect(browserUserAgentOverride(userAgent)).toEqual({ userAgent });
    },
  );

  it('builds presets from the bundled Chrome version and platform', () => {
    const presets = browserUserAgentPresets('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7559.60 Safari/537.36');
    expect(presets.map(preset => preset.id)).toEqual(['chrome', 'edge', 'safari', 'firefox']);
    expect(presets.map(preset => `${preset.label} ${preset.version} ${preset.platform}`)).toEqual([
      'Chrome 144 Windows', 'Edge 144 Windows', 'Safari 18.5 macOS', 'Firefox 140 Windows',
    ]);
    expect(presets[2]!.value).toContain('Version/18.5 ');
    expect(presets[3]!.value).toContain('Firefox/140.0');
    expect(presets[0]!.value).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36');
    expect(presets[1]!.value).toMatch(/ Edg\/144\.0\.0\.0$/);
    expect(presets[3]!.value).toContain('Windows NT 10.0; Win64; x64; rv:');
    for (const preset of presets) expect(isBrowserCustomUserAgent(preset.value)).toBe(true);
  });
});

describe('browser request header rewrite', () => {
  const electronHeaders = {
    'User-Agent': 'Mozilla/5.0 Chrome/144.0.0.0 Electron/43.1.1',
    'sec-ch-ua': '"Chromium";v="144", "Not(A:Brand";v="8"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'Sec-CH-UA-Full-Version-List': '"Chromium";v="144.0.7559.60"',
    Accept: '*/*',
  };

  it('adds Chrome low-entropy hints to default-mode requests only on secure URLs', () => {
    const userAgent = defaultBrowserUserAgentOverride('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7559.60 Electron/43.1.1 Safari/537.36');
    const secure = rewriteBrowserRequestHeaders({ url: 'https://accounts.google.com/', requestHeaders: { Accept: '*/*' }, userAgent, deviceMode: false });
    expect(secure).toEqual({
      Accept: '*/*',
      'User-Agent': userAgent.userAgent,
      'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    });
    const insecure = rewriteBrowserRequestHeaders({ url: 'http://example.com/', requestHeaders: { Accept: '*/*' }, userAgent, deviceMode: false });
    expect(insecure).toEqual({ Accept: '*/*', 'User-Agent': userAgent.userAgent });
  });

  it('sends the Electron identity without app tokens to accounts.google.com on the default identity', () => {
    const electronUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) kimi-code-app/1.0.4 Chrome/144.0.7559.60 Electron/43.1.1 Safari/537.36 Kimi Code/1.0.4';
    const userAgent = defaultBrowserUserAgentOverride(electronUserAgent);
    const signIn = rewriteBrowserRequestHeaders({ url: 'https://accounts.google.com/v3/signin/identifier', requestHeaders: { Accept: '*/*' }, userAgent, deviceMode: false, electronUserAgent });
    expect(signIn?.['User-Agent']).toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7559.60 Electron/43.1.1 Safari/537.36');
    expect(rewriteBrowserRequestHeaders({ url: 'https://www.google.com/', requestHeaders: {}, userAgent, deviceMode: false, electronUserAgent })?.['User-Agent']).toBe(userAgent.userAgent);
    expect(rewriteBrowserRequestHeaders({ url: 'https://accounts.google.com/', requestHeaders: {}, userAgent, deviceMode: true, electronUserAgent })).toBeNull();
    expect(rewriteBrowserRequestHeaders({ url: 'https://accounts.google.com/', requestHeaders: {}, userAgent: browserUserAgentOverride(EDGE), deviceMode: false })?.['User-Agent']).toBe(EDGE);
  });

  it('leaves device mode requests to the device profile', () => {
    const userAgent = browserUserAgentOverride(CHROME);
    expect(rewriteBrowserRequestHeaders({ url: 'https://example.com/', requestHeaders: electronHeaders, userAgent, deviceMode: true })).toBeNull();
  });

  it('rewrites Chrome client hints to match the custom string', () => {
    const next = rewriteBrowserRequestHeaders({ url: 'https://example.com/', requestHeaders: electronHeaders, userAgent: browserUserAgentOverride(CHROME), deviceMode: false });
    expect(next).toEqual({
      'User-Agent': CHROME,
      Accept: '*/*',
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-ch-ua-full-version-list': '"Google Chrome";v="131.0.0.0", "Chromium";v="131.0.0.0", "Not_A Brand";v="24.0.0.0"',
    });
  });

  it('adds low-entropy Edge hints on secure requests that lack them, but not on insecure ones', () => {
    const userAgent = browserUserAgentOverride(EDGE);
    const secure = rewriteBrowserRequestHeaders({ url: 'https://example.com/sw.js', requestHeaders: { Accept: '*/*' }, userAgent, deviceMode: false });
    expect(secure).toEqual({
      Accept: '*/*',
      'User-Agent': EDGE,
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Microsoft Edge";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    });
    const insecure = rewriteBrowserRequestHeaders({ url: 'http://example.com/', requestHeaders: { Accept: '*/*' }, userAgent, deviceMode: false });
    expect(insecure).toEqual({ Accept: '*/*', 'User-Agent': EDGE });
    const local = rewriteBrowserRequestHeaders({ url: 'http://localhost:3000/', requestHeaders: {}, userAgent, deviceMode: false });
    expect(local).toHaveProperty('sec-ch-ua-platform', '"Windows"');
  });

  it.each([SAFARI, FIREFOX])('strips every client hint for %s', (userAgent) => {
    const next = rewriteBrowserRequestHeaders({ url: 'https://example.com/', requestHeaders: electronHeaders, userAgent: browserUserAgentOverride(userAgent), deviceMode: false });
    expect(next).toEqual({ 'User-Agent': userAgent, Accept: '*/*' });
  });
});
