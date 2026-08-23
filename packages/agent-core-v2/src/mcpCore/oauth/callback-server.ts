import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CallbackResult {
  readonly code: string;
  readonly state: string | undefined;
}

export interface CallbackServer {
  readonly redirectUri: string;
  /**
   * Resolves with the OAuth callback payload, or rejects when:
   *  - `signal` aborts → AbortError
   *  - `timeoutMs` elapses → Error('OAuth callback timed out')
   *  - the user's authorization server returns an error → Error('OAuth error: <code>')
   *  - `close()` is called → OAuthCallbackClosedError
   */
  waitForCode(opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<CallbackResult>;
  close(): Promise<void>;
}

export class OAuthCallbackClosedError extends Error {
  constructor() {
    super('OAuth callback listener closed');
    this.name = 'OAuthCallbackClosedError';
  }
}

const SUCCESS_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Authorized</title></head>' +
  '<body style="font-family:system-ui,sans-serif;padding:2rem;">' +
  '<h1>Sign-in complete</h1>' +
  '<p>You can close this tab and return to the application.</p>' +
  '</body></html>';

const ERROR_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>OAuth error</title></head>' +
  '<body style="font-family:system-ui,sans-serif;padding:2rem;">' +
  '<h1>Sign-in failed</h1>' +
  '<p>The authorization server reported an error. Return to the application for details.</p>' +
  '</body></html>';

export async function startCallbackServer(): Promise<CallbackServer> {
  let resolveCode: ((value: CallbackResult) => void) | undefined;
  let rejectCode: ((reason: Error) => void) | undefined;
  let cleanupWait: (() => void) | undefined;
  let outcome:
    | { readonly status: 'pending' }
    | { readonly status: 'resolved'; readonly value: CallbackResult }
    | { readonly status: 'rejected'; readonly reason: Error } = { status: 'pending' };

  const settle = (
    next:
      | { readonly status: 'resolved'; readonly value: CallbackResult }
      | { readonly status: 'rejected'; readonly reason: Error },
  ) => {
    if (outcome.status !== 'pending') return;
    outcome = next;
    cleanupWait?.();
    cleanupWait = undefined;
    if (next.status === 'resolved') {
      resolveCode?.(next.value);
    } else {
      rejectCode?.(next.reason);
    }
    resolveCode = undefined;
    rejectCode = undefined;
    void closeServer();
  };

  const server: Server = createServer((req, res) => {
    handle(req, res);
  });

  function handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET' || req.url === undefined) {
      res.writeHead(404).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(404).end();
      return;
    }
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const errorParam = url.searchParams.get('error');
    if (errorParam !== null) {
      const description = url.searchParams.get('error_description') ?? '';
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(ERROR_HTML);
      settle({
        status: 'rejected',
        reason: new Error(
          `OAuth error: ${errorParam}${description ? ` — ${description}` : ''}`,
        ),
      });
      return;
    }
    const code = url.searchParams.get('code');
    if (code === null || code.length === 0) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(ERROR_HTML);
      settle({
        status: 'rejected',
        reason: new Error('OAuth callback missing authorization code'),
      });
      return;
    }
    const state = url.searchParams.get('state') ?? undefined;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(SUCCESS_HTML);
    settle({ status: 'resolved', value: { code, state } });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  let closeServerPromise: Promise<void> | undefined;
  const closeServer = (): Promise<void> => {
    closeServerPromise ??= new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    return closeServerPromise;
  };
  const close = async () => {
    settle({ status: 'rejected', reason: new OAuthCallbackClosedError() });
    await closeServer();
  };

  const waitForCode: CallbackServer['waitForCode'] = ({ signal, timeoutMs } = {}) => {
    return new Promise<CallbackResult>((resolve, reject) => {
      if (outcome.status === 'resolved') {
        resolve(outcome.value);
        return;
      }
      if (outcome.status === 'rejected') {
        reject(outcome.reason);
        return;
      }

      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        settle({
          status: 'rejected',
          reason:
            signal?.reason instanceof Error ? signal.reason : new Error('OAuth flow aborted'),
        });
      };
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      cleanupWait = cleanup;
      resolveCode = resolve;
      rejectCode = reject;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          settle({ status: 'rejected', reason: new Error('OAuth callback timed out') });
        }, timeoutMs);
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  };

  return { redirectUri, waitForCode, close };
}
