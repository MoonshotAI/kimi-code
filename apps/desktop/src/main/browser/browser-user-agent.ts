import { app } from 'electron';
import {
  browserUserAgentOverride,
  defaultBrowserUserAgentOverride,
  strippedBrowserUserAgent,
  type BrowserHostArchitecture,
  type BrowserUserAgentOverride,
} from '../../shared/browser-user-agent';
import { getBrowserPreferences } from '../app/ui-state';

let cached: { override: BrowserUserAgentOverride | null } | undefined;

export function browserHostArchitecture(): BrowserHostArchitecture {
  return process.arch === 'arm64' || process.arch === 'arm' ? 'arm' : 'x86';
}

export function electronUserAgent(): string {
  return app.userAgentFallback;
}

export function defaultBrowserUserAgent(): string {
  return strippedBrowserUserAgent(electronUserAgent());
}

export function customBrowserUserAgent(): BrowserUserAgentOverride | null {
  if (cached === undefined) {
    const value = getBrowserPreferences().customUserAgent;
    cached = { override: value === null ? null : browserUserAgentOverride(value, browserHostArchitecture()) };
  }
  return cached.override;
}

export function activeBrowserUserAgent(): BrowserUserAgentOverride {
  return customBrowserUserAgent() ?? defaultBrowserUserAgentOverride(electronUserAgent(), browserHostArchitecture());
}

export function resetCustomBrowserUserAgentCache(): void {
  cached = undefined;
}
