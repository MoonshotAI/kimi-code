/**
 * Loopback redirect server for the Okta authorization-code flow. The browser
 * lands on `http://127.0.0.1:<port><redirectPath>?code=...&state=...` after
 * the IdP authenticates the user; the server validates the state, answers
 * with a minimal "you can close this page" document, and settles exactly one
 * callback promise. Ports are tried in order so a busy port does not fail the
 * whole login; the caller disposes the server when done (timeout, cancel, or
 * after the code was exchanged).
 */
import * as http from "node:http";

export type LoopbackCallbackResult =
  | { readonly code: string }
  | { readonly error: string };

export interface LoopbackServer {
  readonly port: number;
  readonly redirectUri: string;
  readonly callback: Promise<LoopbackCallbackResult>;
  dispose(): void;
}

const CALLBACK_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Sign-in complete</title></head>
<body style="font-family: sans-serif; text-align: center; padding-top: 3rem">
<h2>Sign-in complete</h2><p>You can close this page and return to VS Code.</p>
</body></html>`;

export async function startLoopbackServer(options: {
  readonly ports: readonly number[];
  readonly redirectPath: string;
  readonly state: string;
}): Promise<LoopbackServer> {
  if (options.ports.length === 0) {
    throw new Error("Okta loopback server has no ports configured.");
  }
  const triedPorts: number[] = [];
  for (const port of options.ports) {
    triedPorts.push(port);
    try {
      return await listenOnce(port, options);
    } catch (error) {
      if (!isAddrInUse(error)) throw error;
    }
  }
  throw new Error(
    `Okta callback ports are all in use: ${triedPorts.join(", ")}. Free one of them or adjust "callbackPorts" in okta.json.`,
  );
}

function listenOnce(port: number, options: {
  readonly redirectPath: string;
  readonly state: string;
}): Promise<LoopbackServer> {
  return new Promise<LoopbackServer>((resolve, reject) => {
    let settled = false;
    let disposed = false;
    let settle: (result: LoopbackCallbackResult) => void = () => {};
    const callback = new Promise<LoopbackCallbackResult>((resolveCallback) => {
      settle = resolveCallback;
    });

    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== options.redirectPath) {
        response.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      if (error !== null) {
        respondAndSettle(response, `Okta authorization failed: ${error}`, () => {
          settleIf(() => {
            settle({ error: `Okta authorization failed: ${error}` });
          });
        });
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (code === null || state !== options.state) {
        // A foreign or tampered callback: answer, but never settle the flow.
        response.writeHead(400).end("Invalid callback");
        return;
      }
      respondAndSettle(response, undefined, () => {
        settleIf(() => {
          settle({ code });
        });
      });
    });

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      settleIf(() => {
        settle({ error: "Sign-in window closed." });
      });
      server.close();
    };

    const settleIf = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (disposed) return;
      server.close();
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port,
        redirectUri: `http://127.0.0.1:${port}${options.redirectPath}`,
        callback,
        dispose,
      });
    });
  });
}

function respondAndSettle(
  response: http.ServerResponse,
  error: string | undefined,
  settle: () => void,
): void {
  response.writeHead(error === undefined ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
  response.end(error === undefined ? CALLBACK_HTML : error);
  settle();
}

function isAddrInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EADDRINUSE"
  );
}
