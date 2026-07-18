/**
 * One-shot localhost OAuth callback listener.
 *
 * `startCallbackServer()` binds 127.0.0.1 on a random free port and returns a
 * handle exposing the resulting `redirect_uri` and an awaitable
 * `waitForCode()` that resolves with `{ code, state }` from the first
 * `/callback` request. Any subsequent requests get a generic 404 and a
 * non-callback path is ignored. The server is closed automatically once a
 * code has been delivered (or `close()` is called explicitly).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CallbackResult {
  readonly code: string;
  readonly state: string | undefined;
}

export interface CallbackServer {
  readonly redirectUri: string;
  waitForCode(opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<CallbackResult>;
  close(): Promise<void>;
}

const SUCCESS_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Authorized</title></head>' +
  '<body style="font-family:system-ui,sans-serif;padding:2rem;">' +
  '<h1>Sign-in complete</h1>' +
  '<p>You can close this tab and return to kimi-code.</p>' +
  '</body></html>';

const ERROR_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>OAuth error</title></head>' +
  '<body style="font-family:system-ui,sans-serif;padding:2rem;">' +
  '<h1>Sign-in failed</h1>' +
  '<p>The authorization server reported an error. Return to kimi-code for details.</p>' +
  '</body></html>';

export async function startCallbackServer(): Promise<CallbackServer> {
  let resolveCode: ((value: CallbackResult) => void) | undefined;
  let rejectCode: ((reason: Error) => void) | undefined;
  let settled = false;

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
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
      settle(() => {
        rejectCode?.(
          new Error(`OAuth error: ${errorParam}${description ? ` — ${description}` : ''}`),
        );
      });
      return;
    }
    const code = url.searchParams.get('code');
    if (code === null || code.length === 0) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(ERROR_HTML);
      settle(() => {
        rejectCode?.(new Error('OAuth callback missing authorization code'));
      });
      return;
    }
    const state = url.searchParams.get('state') ?? undefined;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(SUCCESS_HTML);
    settle(() => {
      resolveCode?.({ code, state });
    });
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

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  };

  const waitForCode: CallbackServer['waitForCode'] = ({ signal, timeoutMs } = {}) => {
    return new Promise<CallbackResult>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        settle(() =>
          rejectCode?.(
            signal?.reason instanceof Error ? signal.reason : new Error('OAuth flow aborted'),
          ),
        );
      };
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      resolveCode = (value) => {
        cleanup();
        void close();
        resolve(value);
      };
      rejectCode = (reason) => {
        cleanup();
        void close();
        reject(reason);
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          settle(() => rejectCode?.(new Error('OAuth callback timed out')));
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
