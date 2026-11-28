import { TestkitError } from '#/errors';

export type QueryValue = string | number | boolean | undefined;

export interface KapRequest {
  readonly method?: string;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface KapExchange {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly json: boolean;
  readonly body: string | undefined;
}

export type KapExchangeRecorder = (exchange: Promise<KapExchange>) => void;

export class KapEnvelopeError extends TestkitError {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly code: number | undefined,
    readonly body: unknown,
  ) {
    super(`KAP ${method} ${path} failed with HTTP ${status}${code === undefined ? '' : ` and code ${code}`}: ${JSON.stringify(body).slice(0, 500)}`);
    this.name = 'KapEnvelopeError';
  }
}

export class KapRest {
  constructor(
    readonly origin: string,
    private readonly token: () => string | undefined,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly onExchange?: KapExchangeRecorder,
  ) {}

  async raw(path: string, request: KapRequest = {}): Promise<Response> {
    const headers: Record<string, string> = { ...request.headers };
    const token = this.token();
    if (token !== undefined && headers['authorization'] === undefined) headers['authorization'] = `Bearer ${token}`;
    let body: string | undefined;
    if (request.body !== undefined) {
      headers['content-type'] ??= 'application/json';
      body = JSON.stringify(request.body);
    }
    const fetchImpl = this.fetchImpl;
    const url = this.url(path, request.query);
    const method = request.method ?? (request.body === undefined ? 'GET' : 'POST');
    const response = await fetchImpl(url, { method, headers, body, signal: request.signal });
    this.onExchange?.(exchangeOf(method, new URL(url).pathname, response));
    return response;
  }

  async request<T>(path: string, request: KapRequest = {}): Promise<T> {
    const method = request.method ?? (request.body === undefined ? 'GET' : 'POST');
    const response = await this.raw(path, request);
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      throw new KapEnvelopeError(method, path, response.status, undefined, text);
    }
    const envelope = parsed as { readonly code?: unknown; readonly data?: unknown } | undefined;
    const code = typeof envelope?.code === 'number' ? envelope.code : undefined;
    if (!response.ok || code !== 0) throw new KapEnvelopeError(method, path, response.status, code, parsed);
    return envelope?.data as T;
  }

  get<T>(path: string, query?: Readonly<Record<string, QueryValue>>): Promise<T> {
    return this.request<T>(path, { method: 'GET', query });
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>(path, { method: 'POST', body });
  }

  put<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>(path, { method: 'PUT', body });
  }

  patch<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body });
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' });
  }

  private url(path: string, query: Readonly<Record<string, QueryValue>> | undefined): string {
    const url = new URL(path, this.origin);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
}

async function exchangeOf(method: string, path: string, response: Response): Promise<KapExchange> {
  const json = /\bjson\b/i.test(response.headers.get('content-type') ?? '');
  const copy = json ? response.clone() : undefined;
  const body = await copy?.text().catch(() => undefined);
  return { method, path, status: response.status, json, body };
}
