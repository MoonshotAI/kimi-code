import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { createInspectClient, probeDebugSurface, type InspectClient } from './channel';
import { fetchServerDiscovery, pickDefaultServer, useServerDiscovery } from './servers';

export interface ConnectionConfig {
  readonly url: string;
  readonly token: string;
}

export interface ConnectOptions {
  readonly persist?: boolean;
  readonly rememberServerUrl?: string;
}

const STORAGE_KEY = 'kimi-inspect.connection';
const REMEMBERED_SERVER_KEY = 'kimi-inspect.server-url';

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
  }
  return { url: '', token: '' };
}

export function resolveBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/$/, '');
  if (trimmed === '') return window.location.origin;
  return trimmed;
}

interface ConnectionValue {
  readonly config: ConnectionConfig;
  readonly baseUrl: string;
  readonly klient: InspectClient;
  readonly connect: (config: ConnectionConfig, opts?: ConnectOptions) => void;
  readonly disconnect: () => void;
}

const ConnectionContext = createContext<ConnectionValue | null>(null);

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ConnectionConfig | null>(() => {
    const initial = readInitialConfig();
    const params = new URLSearchParams(window.location.search);
    if (params.has('url') || params.has('token')) return initial;
    return localStorage.getItem(STORAGE_KEY) !== null ? initial : null;
  });
  const [discovering, setDiscovering] = useState(config === null);
  const [suppressDiscovery, setSuppressDiscovery] = useState(false);

  useEffect(() => {
    if (config !== null || suppressDiscovery) return;
    let cancelled = false;
    setDiscovering(true);
    void fetchServerDiscovery().then((discovery) => {
      if (cancelled) return;
      setDiscovering(false);
      if (discovery === null) return;
      const pick = pickDefaultServer(discovery, localStorage.getItem(REMEMBERED_SERVER_KEY));
      if (pick === undefined) return;
      setConfig({ url: pick.url, token: discovery.token ?? '' });
    });
    return () => {
      cancelled = true;
    };
  }, [config, suppressDiscovery]);

  const [probe, setProbe] = useState<{
    readonly key: string;
    readonly error: string | null;
  } | null>(null);
  const [probeNonce, setProbeNonce] = useState(0);
  const configKey = config === null ? null : `${resolveBaseUrl(config.url)}|${config.token.trim()}`;

  useEffect(() => {
    if (config === null || configKey === null) {
      setProbe(null);
      return;
    }
    let cancelled = false;
    const token = config.token.trim();
    void probeDebugSurface({
      baseUrl: resolveBaseUrl(config.url),
      token: token === '' ? undefined : token,
    }).then(
      () => {
        if (!cancelled) setProbe({ key: configKey, error: null });
      },
      (error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setProbe({ key: configKey, error: message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [config, configKey, probeNonce]);

  const klient = useMemo(() => {
    if (config === null || configKey === null) return null;
    if (probe === null || probe.key !== configKey || probe.error !== null) return null;
    const token = config.token.trim();
    return createInspectClient({
      url: resolveBaseUrl(config.url),
      token: token === '' ? undefined : token,
    });
  }, [config, configKey, probe]);

  const connect = useCallback((next: ConnectionConfig, opts: ConnectOptions = {}) => {
    if (opts.persist ?? true) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
    if (opts.rememberServerUrl !== undefined) {
      localStorage.setItem(REMEMBERED_SERVER_KEY, opts.rememberServerUrl);
    }
    setSuppressDiscovery(false);
    setConfig(next);
  }, []);

  const disconnect = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(REMEMBERED_SERVER_KEY);
    setSuppressDiscovery(true);
    setConfig(null);
  }, []);

  const retryProbe = useCallback(() => {
    setProbe(null);
    setProbeNonce((n) => n + 1);
  }, []);

  const value = useMemo<ConnectionValue | null>(() => {
    if (klient === null || config === null) return null;
    return { config, baseUrl: resolveBaseUrl(config.url), klient, connect, disconnect };
  }, [klient, config, connect, disconnect]);

  const probeFailure =
    config !== null && probe !== null && probe.key === configKey && probe.error !== null
      ? { baseUrl: resolveBaseUrl(config.url), error: probe.error }
      : null;

  return (
    <ConnectionContext.Provider value={value}>
      {value !== null ? (
        children
      ) : probeFailure !== null ? (
        <DebugSurfaceError
          baseUrl={probeFailure.baseUrl}
          error={probeFailure.error}
          onRetry={retryProbe}
          onBack={disconnect}
        />
      ) : config !== null ? (
        <div className="flex h-screen items-center justify-center">
          <div className="text-sm text-neutral-500">
            Connecting to {resolveBaseUrl(config.url)}…
          </div>
        </div>
      ) : discovering && !suppressDiscovery ? (
        <div className="flex h-screen items-center justify-center">
          <div className="text-sm text-neutral-500">Discovering local kap-servers…</div>
        </div>
      ) : (
        <ConnectScreen onConnect={connect} initial={readInitialConfig()} />
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

function DebugSurfaceError({
  baseUrl,
  error,
  onRetry,
  onBack,
}: {
  baseUrl: string;
  error: string;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="w-[520px] rounded-lg border border-red-900/60 bg-neutral-900 p-6 shadow-xl">
        <h1 className="mb-1 text-lg font-semibold text-red-300">Debug surface unavailable</h1>
        <p className="mb-3 text-xs leading-relaxed text-neutral-400">
          Kimi Inspect talks to kap-server exclusively over the debug RPC surface (
          <code className="text-neutral-300">/api/v1/debug</code>), and{' '}
          <code className="text-neutral-300">{baseUrl}</code> does not serve it. Start kap-server
          with <code className="text-neutral-300">--debug-endpoints</code> on a loopback bind and
          retry.
        </p>
        <div className="mb-4 rounded bg-red-950/50 px-2 py-1.5 font-mono text-[11px] text-red-400">
          {error}
        </div>
        <div className="flex gap-2">
          <button
            className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
            onClick={onRetry}
          >
            Retry
          </button>
          <button
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
            onClick={onBack}
          >
            Change server
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectScreen({
  onConnect,
  initial,
}: {
  onConnect: (config: ConnectionConfig, opts?: ConnectOptions) => void;
  initial: ConnectionConfig;
}) {
  const [url, setUrl] = useState(initial.url);
  const [token, setToken] = useState(initial.token);
  const discovery = useServerDiscovery();
  const servers = discovery.data?.servers ?? [];
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
          Connect to a kap-server started with{' '}
          <code className="text-neutral-400">--debug-endpoints</code> (
          <code className="text-neutral-400">/api/v1/debug</code>). Leave the URL empty to use the
          same-origin dev proxy
          {` (${__KIMI_INSPECT_PROXY_TARGET__})`}.
        </p>
        {servers.length > 0 ? (
          <div className="mb-5">
            <div className="mb-1 text-xs text-neutral-400">
              Discovered on this machine{discovery.data?.home ? ` (${discovery.data.home})` : ''}
            </div>
            <div className="space-y-1.5">
              {servers.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="flex w-full items-center gap-2 rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-left text-[12px] text-neutral-200 hover:border-sky-600"
                  onClick={() =>
                    onConnect(
                      { url: s.url, token: discovery.data?.token ?? '' },
                      { persist: false, rememberServerUrl: s.url },
                    )
                  }
                >
                  <span className="font-mono">{s.url.replace(/^https?:\/\//, '')}</span>
                  {s.pid !== undefined ? (
                    <span className="text-[10px] text-neutral-500">pid {s.pid}</span>
                  ) : null}
                  <span className="ml-auto text-[10px] uppercase text-neutral-600">{s.source}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
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
