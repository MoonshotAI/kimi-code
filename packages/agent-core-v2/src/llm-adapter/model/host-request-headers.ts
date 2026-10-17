import { createDecorator } from '#/_base/di/instantiation';

export interface IHostRequestHeaders {
  readonly headers: Readonly<Record<string, string>>;
  readonly thirdPartyHeaders: Readonly<Record<string, string>>;
  readonly identitySlug?: string;
}

export const IHostRequestHeaders = createDecorator<IHostRequestHeaders>('hostRequestHeaders');

const FIRST_PARTY_HOSTS = new Set(['api.moonshot.ai', 'api.moonshot.cn']);

export function isFirstPartyBaseUrl(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined) {
    return true;
  }
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && FIRST_PARTY_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
