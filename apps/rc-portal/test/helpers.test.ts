import { describe, expect, it } from 'vitest';

import { parseRedirectUri, readLocaleCookie, detectEmbeddedBrowser, isIosDevice } from '../src/helpers';

describe('parseRedirectUri', () => {
  it('accepts absolute https URLs', () => {
    expect(parseRedirectUri('https://rc.example.com/s/abc')).toBe('https://rc.example.com/s/abc');
  });

  it('accepts http URLs (local tunnel dev)', () => {
    expect(parseRedirectUri('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/');
  });

  it('rejects non-http schemes', () => {
    expect(parseRedirectUri('javascript:alert(1)')).toBeNull();
  });

  it('rejects missing or unparsable values', () => {
    expect(parseRedirectUri(undefined)).toBeNull();
    expect(parseRedirectUri(null)).toBeNull();
    expect(parseRedirectUri('')).toBeNull();
    expect(parseRedirectUri('//evil.example.com')).toBeNull();
    expect(parseRedirectUri('/relative/path')).toBeNull();
  });

  it('uses the first value of a repeated query parameter', () => {
    expect(parseRedirectUri(['https://rc.example.com/s/abc', 'https://evil.example.com/'])).toBe(
      'https://rc.example.com/s/abc',
    );
    expect(parseRedirectUri([])).toBeNull();
  });
});

describe('readLocaleCookie', () => {
  it('returns null when the cookie is absent', () => {
    expect(readLocaleCookie('')).toBeNull();
    expect(readLocaleCookie('other=1')).toBeNull();
  });

  it('reads zh and en values among several cookies', () => {
    expect(readLocaleCookie('KIMI_LOCALE=zh')).toBe('zh');
    expect(readLocaleCookie('a=1; KIMI_LOCALE=en; session=x')).toBe('en');
  });

  it('accepts regional variants', () => {
    expect(readLocaleCookie('KIMI_LOCALE=zh-CN')).toBe('zh');
    expect(readLocaleCookie('KIMI_LOCALE=en-US')).toBe('en');
  });

  it('ignores unknown values', () => {
    expect(readLocaleCookie('KIMI_LOCALE=fr')).toBeNull();
  });
});

const IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const WECHAT_IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.47 NetType/WIFI Language/zh_CN';
const WECHAT_ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 XWEB/1160065 MMWEBSDK/20240404 MMWEBID/1234 MicroMessenger/8.0.48.2580(0x28003036) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64';
const WEWORK_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.47 wxwork/4.1.20 Language/zh_CN';
const FEISHU_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Feishu/7.20.0 LarkLocale/zh_CN';
const LARK_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 Lark/7.20.0 LarkLocale/en_US';

describe('detectEmbeddedBrowser', () => {
  it('detects WeChat on iOS and Android', () => {
    expect(detectEmbeddedBrowser(WECHAT_IOS_UA)).toBe('wechat');
    expect(detectEmbeddedBrowser(WECHAT_ANDROID_UA)).toBe('wechat');
  });

  it('detects WeCom (shares the MicroMessenger token)', () => {
    expect(detectEmbeddedBrowser(WEWORK_UA)).toBe('wechat');
  });

  it('detects Feishu and Lark', () => {
    expect(detectEmbeddedBrowser(FEISHU_UA)).toBe('lark');
    expect(detectEmbeddedBrowser(LARK_UA)).toBe('lark');
  });

  it('does not flag regular browsers', () => {
    expect(detectEmbeddedBrowser(IPHONE_SAFARI_UA)).toBeNull();
    expect(detectEmbeddedBrowser(ANDROID_CHROME_UA)).toBeNull();
    expect(detectEmbeddedBrowser('')).toBeNull();
  });
});

describe('isIosDevice', () => {
  it('detects iOS user agents', () => {
    expect(isIosDevice(IPHONE_SAFARI_UA)).toBe(true);
    expect(isIosDevice(WECHAT_IOS_UA)).toBe(true);
  });

  it('does not flag Android', () => {
    expect(isIosDevice(ANDROID_CHROME_UA)).toBe(false);
    expect(isIosDevice(WECHAT_ANDROID_UA)).toBe(false);
  });
});
