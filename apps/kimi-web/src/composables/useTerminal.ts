import { onUnmounted, ref, watch, type Ref } from 'vue';
import { getKimiWebApi } from '../api';
import type { AppTerminal, KimiEventConnection } from '../api/types';

export function useTerminal(sessionId: Ref<string>) {
  const terminal = ref<AppTerminal | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const connected = ref(false);
  const readOnly = ref(false);
  const lastSeq = ref(0);

  const outputHandlers = new Set<(data: string) => void>();
  const exitHandlers = new Set<(exitCode: number | null) => void>();
  let conn: KimiEventConnection | null = null;

  function ensureConnection(): KimiEventConnection | null {
    if (conn !== null) return conn;
    if (typeof WebSocket === 'undefined') return null;
    conn = getKimiWebApi().connectEvents({
      onEvent: () => {},
      onResync: () => {},
      onError: (_code, msg) => {
        error.value = msg;
      },
      onConnectionChange: (state) => {
        connected.value = state;
      },
      onTerminalOutput: (sid, terminalId, data, seq) => {
        if (sid !== sessionId.value || terminal.value?.id !== terminalId) return;
        lastSeq.value = Math.max(lastSeq.value, seq);
        for (const handler of outputHandlers) handler(data);
      },
      onTerminalExit: (sid, terminalId, exitCode) => {
        if (sid !== sessionId.value || terminal.value?.id !== terminalId) return;
        readOnly.value = true;
        terminal.value = terminal.value
          ? { ...terminal.value, status: 'exited', exitCode }
          : terminal.value;
        for (const handler of exitHandlers) handler(exitCode);
      },
    });
    return conn;
  }

  async function start(size?: { cols?: number; rows?: number }): Promise<void> {
    const sid = sessionId.value;
    if (!sid || loading.value) return;
    loading.value = true;
    error.value = null;
    try {
      const api = getKimiWebApi();
      const existing = (await api.listTerminals(sid)).find((item) => item.status === 'running');
      const next = existing ?? await api.createTerminal(sid, {
        cols: size?.cols,
        rows: size?.rows,
      });
      terminal.value = next;
      readOnly.value = next.status === 'exited';
      ensureConnection()?.terminalAttach(sid, next.id, lastSeq.value);
    } catch (error_) {
      error.value = error_ instanceof Error ? error_.message : String(error_);
    } finally {
      loading.value = false;
    }
  }

  function write(data: string): void {
    const current = terminal.value;
    if (!current || readOnly.value) return;
    ensureConnection()?.terminalInput(current.sessionId, current.id, data);
  }

  function resize(cols: number, rows: number): void {
    const current = terminal.value;
    if (!current || readOnly.value) return;
    ensureConnection()?.terminalResize(current.sessionId, current.id, cols, rows);
  }

  async function close(): Promise<void> {
    const current = terminal.value;
    if (!current) return;
    readOnly.value = true;
    try {
      ensureConnection()?.terminalClose(current.sessionId, current.id);
      await getKimiWebApi().closeTerminal(current.sessionId, current.id);
    } catch (error_) {
      error.value = error_ instanceof Error ? error_.message : String(error_);
    }
  }

  function restart(): void {
    const current = terminal.value;
    if (current) {
      conn?.terminalDetach(current.sessionId, current.id);
    }
    terminal.value = null;
    readOnly.value = false;
    lastSeq.value = 0;
    void start();
  }

  function onOutput(handler: (data: string) => void): () => void {
    outputHandlers.add(handler);
    return () => outputHandlers.delete(handler);
  }

  function onExit(handler: (exitCode: number | null) => void): () => void {
    exitHandlers.add(handler);
    return () => exitHandlers.delete(handler);
  }

  watch(sessionId, () => {
    const current = terminal.value;
    if (current) conn?.terminalDetach(current.sessionId, current.id);
    terminal.value = null;
    readOnly.value = false;
    lastSeq.value = 0;
  });

  onUnmounted(() => {
    const current = terminal.value;
    if (current) conn?.terminalDetach(current.sessionId, current.id);
    conn?.close();
    conn = null;
  });

  return {
    terminal,
    loading,
    error,
    connected,
    readOnly,
    start,
    write,
    resize,
    close,
    restart,
    onOutput,
    onExit,
  };
}
