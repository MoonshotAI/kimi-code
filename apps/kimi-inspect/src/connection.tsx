/**
 * Connection context — owns the generic wire client (HTTP calls) and its
 * WebSocket (event streams) built from the user-supplied server URL + token.
 * The config persists in localStorage and can be seeded from `?url=` /
 * `?token=` query params so a kap-server startup banner link can deep-link
 * into the app.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type { WsSocketState } from '@moonshot-ai/klient/transports/ws/wsSocket';

import { createGenericKlient, type GenericKlient } from './genericKlient';

export interface ConnectionConfig {
  /** Server base URL; empty string means same-origin (the Vite dev proxy). */
  readonly url: string;
  readonly token: string;
}

const STORAGE_KEY = 'kimi-inspect.connection';

function readInitialConfig(): ConnectionConfig {
  const params = new URLSearchParams(window.location.search);
  const qUrl = params.get('url');
  const qToken = params.get('token');
  if (qUrl !== null || qToken !== null) {
    return { url: qUrl ?? '', token: qToken ?? '' };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as ConnectionConfig;
      return { url: parsed.url ?? '', token: parsed.token ?? '' };
    }
  } catch {
    // corrupt storage — fall through to default
  }
  return { url: '', token: '' };
}

/** Resolve the configured (possibly relative) URL to an absolute base for the SDK. */
export function resolveBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/$/, '');
  if (trimmed === '') return window.location.origin;
  return trimmed;
}

interface ConnectionValue {
  readonly config: ConnectionConfig;
  readonly baseUrl: string;
  readonly klient: GenericKlient;
  readonly wsState: WsSocketState;
  readonly connect: (config: ConnectionConfig) => void;
  readonly disconnect: () => void;
}

const ConnectionContext = createContext<ConnectionValue | null>(null);

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ConnectionConfig | null>(() => {
    const initial = readInitialConfig();
    // Auto-connect only when the user explicitly connected before (stored) or
    // deep-linked (query). First visit shows the connect screen.
    const params = new URLSearchParams(window.location.search);
    if (params.has('url') || params.has('token')) return initial;
    return localStorage.getItem(STORAGE_KEY) !== null ? initial : null;
  });
  const [wsState, setWsState] = useState<WsSocketState>('connecting');

  const klient = useMemo(() => {
    if (config === null) return null;
    const token = config.token.trim();
    return createGenericKlient({
      url: resolveBaseUrl(config.url),
      token: token === '' ? undefined : token,
    });
  }, [config]);

  useEffect(() => {
    if (klient === null) return;
    const ws = klient.ws();
    setWsState(ws.state);
    const sub = ws.onDidChangeState(setWsState);
    return () => {
      sub.dispose();
      ws.close();
    };
  }, [klient]);

  const connect = useCallback((next: ConnectionConfig) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setConfig(next);
  }, []);

  const disconnect = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setConfig(null);
  }, []);

  const value = useMemo<ConnectionValue | null>(() => {
    if (klient === null || config === null) return null;
    return { config, baseUrl: resolveBaseUrl(config.url), klient, wsState, connect, disconnect };
  }, [klient, config, wsState, connect, disconnect]);

  return (
    <ConnectionContext.Provider value={value}>
      {value === null ? (
        <ConnectScreen onConnect={connect} initial={readInitialConfig()} />
      ) : (
        children
      )}
    </ConnectionContext.Provider>
  );
}

export function useConnection(): ConnectionValue {
  const value = useContext(ConnectionContext);
  if (value === null) {
    throw new Error('useConnection used before connecting');
  }
  return value;
}

function ConnectScreen({
  onConnect,
  initial,
}: {
  onConnect: (config: ConnectionConfig) => void;
  initial: ConnectionConfig;
}) {
  const [url, setUrl] = useState(initial.url);
  const [token, setToken] = useState(initial.token);
  return (
    <div className="flex h-screen items-center justify-center">
      <form
        className="w-[420px] rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          onConnect({ url, token });
        }}
      >
        <h1 className="mb-1 text-lg font-semibold text-neutral-100">Kimi Inspect</h1>
        <p className="mb-5 text-xs text-neutral-500">
          Connect to a kap-server (<code className="text-neutral-400">/api/v2</code>). Leave the
          URL empty to use the same-origin dev proxy
          {` (${__KIMI_INSPECT_PROXY_TARGET__})`}.
        </p>
        <label className="mb-1 block text-xs text-neutral-400">Server URL</label>
        <input
          className="mb-4 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-sky-600"
          placeholder="http://127.0.0.1:58627 (empty = dev proxy)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <label className="mb-1 block text-xs text-neutral-400">Bearer token (optional)</label>
        <input
          className="mb-5 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-sky-600"
          placeholder="~/.kimi-code/server.token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <button
          type="submit"
          className="w-full rounded bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500"
        >
          Connect
        </button>
      </form>
    </div>
  );
}

declare const __KIMI_INSPECT_PROXY_TARGET__: string;
