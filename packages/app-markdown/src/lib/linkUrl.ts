const COMMON_SECOND_LEVEL_SUFFIXES = new Set([
  'ac',
  'co',
  'com',
  'edu',
  'go',
  'gov',
  'mil',
  'ne',
  'net',
  'or',
  'org',
]);

export function registeredDomain(hostname: string): string {
  if (hostname === '') return '';
  if (hostname.startsWith('[') || hostname.includes(':')) return hostname;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return hostname;
  const labels = hostname.split('.').filter((label) => label !== '');
  if (labels.length <= 2) return hostname;
  const tld = labels[labels.length - 1]!.toLowerCase();
  const sld = labels[labels.length - 2]!.toLowerCase();
  if (tld.length === 2 && COMMON_SECOND_LEVEL_SUFFIXES.has(sld)) {
    return labels.slice(-3).join('.');
  }
  return labels.slice(-2).join('.');
}

export interface LinkUrlParts {
  leading: string;
  domain: string;
  trailing: string;
}

export function linkUrlParts(href: string): LinkUrlParts | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname;
  if (host === '') return null;
  const bareHost = host.endsWith('.') ? host.slice(0, -1) : host;
  let domain = registeredDomain(bareHost);
  if (bareHost !== domain && !bareHost.endsWith(`.${domain}`)) domain = bareHost;
  const subdomain = bareHost.length > domain.length ? bareHost.slice(0, bareHost.length - domain.length) : '';
  const userinfo =
    url.username === '' && url.password === ''
      ? ''
      : `${url.username}${url.password === '' ? '' : `:${url.password}`}@`;
  const trailingDot = host.length > bareHost.length ? '.' : '';
  const port = url.port === '' ? '' : `:${url.port}`;
  return {
    leading: `${url.protocol}//${userinfo}${subdomain}`,
    domain,
    trailing: `${trailingDot}${port}${url.pathname}${url.search}${url.hash}`,
  };
}
