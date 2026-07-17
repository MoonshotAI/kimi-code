/**
 * Main view — the conversation of the active session + agent.
 *
 * History comes from `IAgentContextMemoryService.get()` (the authoritative
 * context); live turns stream in through the agent `events` subscription
 * (`assistant.delta` / `thinking.delta` / `tool.*`) as ephemeral entries. On
 * `turn.ended` the history is refetched and the ephemeral layer is dropped, so
 * the view always converges to the authoritative context. Prompts go out via
 * `IAgentRPCService.prompt`; `cancel` aborts the running turn.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import { IAgentContextMemoryService } from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextMemory';
import { IAgentRPCService } from '@moonshot-ai/agent-core-v2/agent/rpc/rpc';

import { useConnection } from '../connection';
import { eventType, payloadField, useLiveEvent } from '../live';
import { ActionButton, Badge, ErrorLine } from '../ui';

interface ChatEntry {
  readonly id: string;
  readonly kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'error';
  text: string;
  name?: string;
  args?: string;
  output?: string;
  isError?: boolean;
}

interface HistoryMessage {
  readonly role?: string;
  readonly content?: readonly { type?: string; text?: string; think?: string }[];
  readonly toolCalls?: readonly { id?: string; name?: string; arguments?: string | null }[];
  readonly isError?: boolean;
}

function mapHistory(messages: readonly HistoryMessage[]): ChatEntry[] {
  const entries: ChatEntry[] = [];
  messages.forEach((m, i) => {
    const parts = m.content ?? [];
    const text = parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('\n');
    const think = parts
      .filter((p) => p.type === 'think')
      .map((p) => p.think ?? p.text ?? '')
      .join('\n');
    if (m.role === 'user') {
      entries.push({ id: `h${i}`, kind: 'user', text: text || '[non-text content]' });
    } else if (m.role === 'assistant') {
      if (think !== '') entries.push({ id: `h${i}t`, kind: 'thinking', text: think });
      if (text !== '') entries.push({ id: `h${i}a`, kind: 'assistant', text });
      for (const call of m.toolCalls ?? []) {
        entries.push({
          id: `h${i}c${call.id ?? ''}`,
          kind: 'tool',
          text: '',
          name: call.name ?? 'tool',
          args: call.arguments ?? undefined,
        });
      }
    } else if (m.role === 'tool') {
      entries.push({
        id: `h${i}r`,
        kind: 'tool',
        text: '',
        name: 'result',
        output: text,
        isError: m.isError,
      });
    }
    // system / developer messages (the system prompt) are not shown.
  });
  return entries;
}

export function ChatView({
  sessionId,
  agentId,
  ready,
}: {
  sessionId: string | null;
  agentId: string;
  ready: boolean;
}) {
  const { klient } = useConnection();
  const queryClient = useQueryClient();
  const [stream, setStream] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const enabled = sessionId !== null && ready;
  const history = useQuery({
    queryKey: ['history', sessionId, agentId],
    queryFn: () =>
      klient
        .session(sessionId as string)
        .agent(agentId)
        .service(IAgentContextMemoryService)
        .get(),
    enabled,
  });

  const refetchHistory = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleRefetch = () => {
    if (refetchHistory.current !== undefined) clearTimeout(refetchHistory.current);
    refetchHistory.current = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ['history', sessionId, agentId] });
      setStream([]);
      setRunning(false);
    }, 500);
  };

  useLiveEvent((event) => {
    if (event.source !== 'agent') return;
    const type = eventType(event);
    const data = event.data as Record<string, unknown>;
    switch (type) {
      case 'turn.started':
        setRunning(true);
        return;
      case 'assistant.delta':
      case 'thinking.delta': {
        const turnId = payloadField(data, 'turnId', '?');
        const kind = type === 'assistant.delta' ? 'assistant' : 'thinking';
        const id = `stream:${turnId}:${kind}`;
        const delta = payloadField(data, 'delta', '');
        setStream((prev) => {
          const found = prev.find((e) => e.id === id);
          if (found === undefined) return [...prev, { id, kind, text: delta }];
          return prev.map((e) => (e.id === id ? { ...e, text: e.text + delta } : e));
        });
        return;
      }
      case 'tool.call.started': {
        const callId = payloadField(data, 'toolCallId', String(Math.random()));
        setStream((prev) => [
          ...prev,
          {
            id: `stream:tool:${callId}`,
            kind: 'tool',
            text: '',
            name: payloadField(data, 'name', 'tool'),
            args: typeof data['args'] === 'string' ? data['args'] : JSON.stringify(data['args'] ?? ''),
          },
        ]);
        return;
      }
      case 'tool.result': {
        const callId = payloadField(data, 'toolCallId', '');
        const output = typeof data['output'] === 'string' ? data['output'] : JSON.stringify(data['output']);
        const id = `stream:tool:${callId}`;
        setStream((prev) => {
          const found = prev.find((e) => e.id === id);
          if (found === undefined) {
            return [...prev, { id, kind: 'tool', text: '', name: 'result', output, isError: Boolean(data['isError']) }];
          }
          return prev.map((e) => (e.id === id ? { ...e, output, isError: Boolean(data['isError']) } : e));
        });
        return;
      }
      case 'turn.ended':
      case 'prompt.completed':
      case 'prompt.aborted':
      case 'compaction.completed':
        scheduleRefetch();
        return;
      case 'error': {
        const message =
          typeof data['message'] === 'string'
            ? data['message']
            : JSON.stringify(data).slice(0, 300);
        setStream((prev) => [
          ...prev,
          { id: `stream:err:${Date.now()}`, kind: 'error', text: message },
        ]);
        setRunning(false);
        return;
      }
    }
  });

  const entries = useMemo(
    () => [...mapHistory((history.data ?? []) as readonly HistoryMessage[]), ...stream],
    [history.data, stream],
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [entries.length, stream]);

  const send = async () => {
    if (sessionId === null || input.trim() === '' || running) return;
    const text = input.trim();
    setInput('');
    setSendError(null);
    setStream((prev) => [...prev, { id: `optimistic:${Date.now()}`, kind: 'user', text }]);
    try {
      await klient
        .session(sessionId)
        .agent(agentId)
        .service(IAgentRPCService)
        .prompt({ input: [{ type: 'text', text }] });
    } catch (error) {
      setSendError(error);
    }
  };

  const cancel = async () => {
    if (sessionId === null) return;
    try {
      await klient.session(sessionId).agent(agentId).service(IAgentRPCService).cancel({});
    } catch (error) {
      setSendError(error);
    }
  };

  if (sessionId === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">
        Select a session on the left to open its conversation.
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">
        Loading session…
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2">
        <span className="font-mono text-[11px] text-neutral-400">{sessionId}</span>
        <Badge tone="sky">agent: {agentId}</Badge>
        {running ? <Badge tone="amber">turn running</Badge> : <Badge tone="green">idle</Badge>}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {history.isError ? <ErrorLine error={history.error} /> : null}
        {entries.length === 0 && !history.isLoading ? (
          <div className="text-[12px] text-neutral-600 italic">Empty context — send a prompt below.</div>
        ) : null}
        {entries.map((entry) => (
          <EntryView key={entry.id} entry={entry} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-neutral-800 p-3">
        {sendError !== null ? <div className="mb-2"><ErrorLine error={sendError} /></div> : null}
        <div className="flex gap-2">
          <textarea
            className="min-h-[40px] flex-1 resize-y rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-[13px] text-neutral-100 outline-none focus:border-sky-600"
            placeholder="Send a prompt to the active agent… (Enter to send, Shift+Enter for newline)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="flex flex-col gap-2">
            <ActionButton onClick={() => void send()} disabled={running || input.trim() === ''}>
              Send
            </ActionButton>
            <ActionButton onClick={() => void cancel()} danger disabled={!running}>
              Cancel
            </ActionButton>
          </div>
        </div>
      </div>
    </div>
  );
}

function EntryView({ entry }: { entry: ChatEntry }) {
  if (entry.kind === 'user') {
    return (
      <div className="mb-3 flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-sky-900/40 px-3 py-2 text-[13px] text-neutral-100">
          {entry.text}
        </div>
      </div>
    );
  }
  if (entry.kind === 'thinking') {
    return (
      <div className="mb-3 max-w-[85%] whitespace-pre-wrap rounded-lg border border-dashed border-neutral-700 px-3 py-2 font-mono text-[11px] text-neutral-500">
        {entry.text}
      </div>
    );
  }
  if (entry.kind === 'tool') {
    return (
      <div className="mb-3 max-w-[85%] rounded-lg border border-neutral-800 bg-neutral-900/50 px-3 py-2 font-mono text-[11px]">
        <div className="mb-1 flex items-center gap-2">
          <Badge tone={entry.isError ? 'red' : 'neutral'}>tool</Badge>
          <span className="text-neutral-300">{entry.name}</span>
        </div>
        {entry.args !== undefined ? (
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-neutral-500">{entry.args}</pre>
        ) : null}
        {entry.output !== undefined ? (
          <pre className={`max-h-40 overflow-auto whitespace-pre-wrap ${entry.isError ? 'text-red-400' : 'text-neutral-400'}`}>
            {entry.output}
          </pre>
        ) : null}
      </div>
    );
  }
  if (entry.kind === 'error') {
    return (
      <div className="mb-3 max-w-[85%] rounded-lg bg-red-950/50 px-3 py-2 text-[12px] text-red-400">
        {entry.text}
      </div>
    );
  }
  return (
    <div className="mb-3 max-w-[85%] whitespace-pre-wrap rounded-lg bg-neutral-800/60 px-3 py-2 text-[13px] text-neutral-100">
      {entry.text}
    </div>
  );
}
