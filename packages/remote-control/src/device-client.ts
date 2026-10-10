import { join } from 'node:path';

import {
  FileTokenStorage,
  resolveKimiRemoteControlAuth,
  resolveKimiTokenStorageName,
  type KimiRemoteControlAuth,
} from '@moonshot-ai/kimi-code-oauth';

import { resolveRemoteControlRelayOrigin } from './remote-control';

export interface RemoteControlDevice {
  readonly device_id: string;
  readonly alias: string;
  readonly status: 'online' | 'offline';
  readonly platform: string;
  readonly client_version: string;
  readonly local_base_url: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_remote_access_at: string;
}

export interface RemoteControlDeviceList {
  readonly devices: RemoteControlDevice[];
  readonly max_devices?: number;
}

export class RemoteControlDeviceClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RemoteControlDeviceClientError';
  }
}

export interface RemoteControlDeviceClientOptions {
  readonly homeDir: string;
  readonly configuredOAuthKey?: () => string | undefined;
  readonly configuredOAuthHost?: () => string | undefined;
  readonly relayOrigin?: string;
  readonly fetchImpl?: typeof fetch;
}

interface RemoteControlDeviceContext {
  readonly auth: KimiRemoteControlAuth;
  readonly relayOrigin: string;
  readonly cacheKey: string;
}

export class RemoteControlDeviceClient {
  private readonly cookies = new Map<string, string>();
  private readonly exchanges = new Map<string, Promise<string>>();
  private readonly fetchImpl: typeof fetch;
  private sessionGeneration = 0;

  constructor(private readonly options: RemoteControlDeviceClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  clear(): void {
    this.sessionGeneration += 1;
    this.cookies.clear();
    this.exchanges.clear();
  }

  async listDevices(): Promise<RemoteControlDeviceList> {
    const response = await this.request('/v1/remote/devices', { method: 'GET' });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new RemoteControlDeviceClientError('Remote Control device list returned invalid JSON.');
    }
    const record = isRecord(body) ? body : {};
    return {
      devices: Array.isArray(record['devices'])
        ? (record['devices'] as RemoteControlDevice[])
        : [],
      max_devices:
        typeof record['max_devices'] === 'number' ? record['max_devices'] : undefined,
    };
  }

  async renameDevice(deviceId: string, alias: string): Promise<void> {
    await this.request(`/v1/remote/devices/${encodeURIComponent(deviceId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ alias }),
    });
  }

  async deactivateDevice(deviceId: string): Promise<void> {
    await this.request(
      `/v1/remote/devices/${encodeURIComponent(deviceId)}/deactivate`,
      { method: 'POST' },
    );
  }

  async deleteDevice(deviceId: string): Promise<void> {
    await this.request(`/v1/remote/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
    });
  }

  private context(): RemoteControlDeviceContext {
    const auth = resolveKimiRemoteControlAuth({
      configuredOAuthHost: this.options.configuredOAuthHost?.(),
      configuredOAuthKey: this.options.configuredOAuthKey?.(),
      homeDir: this.options.homeDir,
    });
    const relayOrigin = (
      this.options.relayOrigin ??
      resolveRemoteControlRelayOrigin(process.env, auth.relayOrigin)
    ).replace(/\/+$/, '');
    return {
      auth,
      relayOrigin,
      cacheKey: `${this.sessionGeneration}\0${relayOrigin}\0${auth.oauthKey}`,
    };
  }

  private async request(
    path: string,
    init: { method: string; body?: string },
  ): Promise<Response> {
    try {
      const context = this.context();
      let cookie = await this.sessionCookie(context, false);
      let response = await this.send(context, path, init, cookie);
      if (response.status === 401) {
        this.cookies.delete(context.cacheKey);
        cookie = await this.sessionCookie(context, true);
        response = await this.send(context, path, init, cookie);
      }
      if (!response.ok) {
        throw await responseError('Remote Control device request failed', response);
      }
      return response;
    } catch (error) {
      if (error instanceof RemoteControlDeviceClientError) throw error;
      throw new RemoteControlDeviceClientError(
        `Remote Control device request failed: ${errorMessage(error)}`,
      );
    }
  }

  private send(
    context: RemoteControlDeviceContext,
    path: string,
    init: { method: string; body?: string },
    cookie: string,
  ): Promise<Response> {
    const headers: Record<string, string> = { Cookie: cookie };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    return this.fetchImpl(relayHttpUrl(context.relayOrigin, path), {
      method: init.method,
      headers,
      body: init.body,
    });
  }

  private sessionCookie(
    context: RemoteControlDeviceContext,
    refresh: boolean,
  ): Promise<string> {
    if (!refresh) {
      const cached = this.cookies.get(context.cacheKey);
      if (cached !== undefined) return Promise.resolve(cached);
    }
    const pending = this.exchanges.get(context.cacheKey);
    if (pending !== undefined) return pending;
    const exchange = this.exchange(context)
      .then((cookie) => {
        this.cookies.set(context.cacheKey, cookie);
        return cookie;
      })
      .finally(() => {
        this.exchanges.delete(context.cacheKey);
      });
    this.exchanges.set(context.cacheKey, exchange);
    return exchange;
  }

  private async exchange(context: RemoteControlDeviceContext): Promise<string> {
    const storage = new FileTokenStorage(join(this.options.homeDir, 'credentials'));
    const token = await storage.load(
      resolveKimiTokenStorageName({ oauthKey: context.auth.oauthKey }),
    );
    if (token?.refreshToken === undefined || token.refreshToken.length === 0) {
      throw new RemoteControlDeviceClientError('Remote Control requires a Kimi login.');
    }
    let response: Response;
    try {
      response = await this.fetchImpl(relayHttpUrl(context.relayOrigin, '/auth/exchange'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: token.accessToken,
          refresh_token: token.refreshToken,
          expires_in: token.expiresIn,
        }),
      });
    } catch (error) {
      throw new RemoteControlDeviceClientError(
        `Remote Control session exchange failed: ${errorMessage(error)}`,
      );
    }
    if (response.status !== 204) {
      throw await responseError('Remote Control session exchange failed', response);
    }
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';', 1)[0]!.trim())
      .filter((value) => value.length > 0)
      .join('; ');
    if (cookie.length === 0) {
      throw new RemoteControlDeviceClientError(
        'Remote Control session exchange did not return a session cookie.',
      );
    }
    return cookie;
  }
}

function relayHttpUrl(origin: string, path: string): string {
  const url = new URL(origin);
  const relayPath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${relayPath}${path}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function responseError(action: string, response: Response): Promise<RemoteControlDeviceClientError> {
  let detail: string | undefined;
  try {
    detail = cloudErrorMessage(await response.json());
  } catch {}
  return new RemoteControlDeviceClientError(
    `${action} (HTTP ${response.status})${detail === undefined ? '.' : `: ${detail}`}`,
    response.status,
  );
}

function cloudErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const error = value['error'];
  const raw =
    isRecord(error) && typeof error['message'] === 'string'
      ? error['message']
      : typeof value['message'] === 'string'
        ? value['message']
        : undefined;
  if (raw === undefined) return undefined;
  const message = raw.replaceAll(/\s+/g, ' ').trim().slice(0, 300);
  return message.length === 0 ? undefined : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
