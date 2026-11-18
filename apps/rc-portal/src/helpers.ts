
export function parseRedirectUri(
  value: string | null | undefined | (string | null)[],
): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.toString();
}

export type EmbeddedBrowser = 'wechat' | 'lark';

export function detectEmbeddedBrowser(ua: string): EmbeddedBrowser | null {
  if (/micromessenger/i.test(ua)) return 'wechat';
  if (/feishu|lark/i.test(ua)) return 'lark';
  return null;
}

export function isIosDevice(ua: string): boolean {
  return /iphone|ipad|ipod/i.test(ua);
}

const LOCALE_COOKIE_NAME = 'KIMI_LOCALE';

export function readLocaleCookie(cookieString: string): 'en' | 'zh' | null {
  for (const part of cookieString.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === LOCALE_COOKIE_NAME) {
      const value = rest.join('=').toLowerCase();
      if (value.startsWith('zh')) return 'zh';
      if (value.startsWith('en')) return 'en';
      return null;
    }
  }
  return null;
}
