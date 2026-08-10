/**
 * Local Kimi auth facade — minimal port of `@moonshot-ai/kimi-code-sdk`
 * `auth.ts` `KimiAuthFacade` (G-1 CLI consumption cutover).
 *
 * The TS host telemetry path only needs the cached managed kimi-code access
 * token, so this is a read-only subset of the SDK facade: no login, refresh,
 * or status flows. The token is read straight from the oauth credential file
 * (`<homeDir>/credentials/kimi-code.json`, snake_case wire format) that the
 * login flows persist.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { KIMI_CODE_PROVIDER_NAME, type KimiHostIdentity } from '#/cli/oauth-local';

export interface KimiAuthFacadeOptions {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity?: KimiHostIdentity | undefined;
}

/**
 * The default managed kimi-code oauth key (`oauth/kimi-code`) resolves to the
 * token storage name `kimi-code`. Custom base-url / oauth-host configurations
 * use a sha256-derived storage name the host does not track here; for those
 * the facade degrades to "no token" — telemetry auth is best-effort and a
 * missing token only drops the auth header from telemetry requests.
 */
const DEFAULT_TOKEN_STORAGE_NAME = 'kimi-code';

export class KimiAuthFacade {
  constructor(private readonly options: KimiAuthFacadeOptions) {}

  getCachedAccessToken(providerName?: string): Promise<string | undefined> {
    return Promise.resolve(this.readCachedAccessToken(providerName));
  }

  private readCachedAccessToken(providerName: string | undefined): string | undefined {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    if (name !== KIMI_CODE_PROVIDER_NAME) return undefined;
    const file = join(this.options.homeDir, 'credentials', `${DEFAULT_TOKEN_STORAGE_NAME}.json`);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf-8');
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const accessToken = (parsed as Record<string, unknown>)['access_token'];
    return typeof accessToken === 'string' && accessToken.length > 0 ? accessToken : undefined;
  }
}
