/**
 * Right sidebar — access point for the Services of the active session and
 * the active agent. Hosts the agent switcher, two tabs (session / agent),
 * the pending-interaction card, and the Service panels (`ScopePanels`).
 * The app-scope (server-level) Services live in their own rail view
 * (`AppServicesView`), not here.
 *
 * Everything here is fetch-on-demand (Load / Refresh buttons): the v2 event
 * socket (`/api/v2/ws`) that used to push core/session/agent event streams
 * — live panel refetches, the pending-interaction push, the merged event
 * log — was removed server-side, so there is no live push to render.
 */

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { ISessionApprovalService } from '@moonshot-ai/agent-core-v2/session/approval/approval';
import { ISessionMetadata } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { ISessionQuestionService } from '@moonshot-ai/agent-core-v2/session/question/question';
import { ISessionInteractionService } from '@moonshot-ai/agent-core-v2/session/interaction/interaction';

import { serviceByName } from '../channel';
import { useConnection } from '../connection';
import { type AnyService } from '../panels';
import { ActionButton, Badge, ErrorLine, JsonView, relTime } from '../ui';
import { ScopePanels } from './ServicePanels';

type Tab = 'session' | 'agent';

export function Inspector({
  sessionId,
  agentId,
  onAgentChange,
  ready,
}: {
  sessionId: string | null;
  agentId: string;
  onAgentChange: (agentId: string) => void;
  ready: boolean;
}) {
  const { klient } = useConnection();
  const [tab, setTab] = useState<Tab>('session');

  const meta = useQuery({
    queryKey: ['sessionMeta', sessionId],
    queryFn: () => klient.session(sessionId as string).service(ISessionMetadata).read(),
    enabled: sessionId !== null && ready,
  });

  const agentIds = useMemo(() => {
    const ids = Object.keys(meta.data?.agents ?? {});
    if (ids.length === 0) return ['main'];
    return ['main', ...ids.filter((id) => id !== 'main')].filter(
      (id, i, all) => all.indexOf(id) === i,
    );
  }, [meta.data]);

  // Keep the selected agent valid as the registry changes.
  const effectiveAgent = agentIds.includes(agentId) ? agentId : agentIds[0]!;
  useEffect(() => {
    if (effectiveAgent !== agentId) onAgentChange(effectiveAgent);
  }, [effectiveAgent, agentId, onAgentChange]);

  // Subagents stay in the metadata registry even when their scope is not
  // materialized in this process (created before a restart, or disposed on
  // session close), so the switcher lists entries that cannot be called.
  // Mark one as "not loaded" when an agent-scope call comes back with
  // `agent.not_found` (message names the agent).
  const [stoppedAgents, setStoppedAgents] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setStoppedAgents(new Set()), [sessionId]);
  const noteAgentError = (agent: string, error: unknown) => {
    if (error instanceof Error && error.message.includes('not found in session')) {
      setStoppedAgents((prev) => (prev.has(agent) ? prev : new Set(prev).add(agent)));
    }
  };

  // Resolve a Service proxy by channel name, 1:1 with the channel descriptor
  // from `/api/v1/debug/channels`. Returns null when the scope needs a
  // session that isn't selected/ready.
  const proxyFor = useMemo(() => {
    return (name: string): AnyService | null => {
      return serviceByName<AnyService>(klient, name, {
        scope: tab,
        sessionId: sessionId !== null && ready ? sessionId : undefined,
        agentId: effectiveAgent,
      }) ?? null;
    };
  }, [klient, tab, sessionId, effectiveAgent, ready]);

  const sessionBlocked = sessionId === null || !ready;

  return (
    <div className="flex h-full w-[420px] shrink-0 flex-col border-l border-neutral-800 bg-neutral-900/30">
      {/* Agent switcher */}
      {sessionId !== null ? (
        <div className="border-b border-neutral-800 px-3 py-2">
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Active agent
          </label>
          <select
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-[12px] text-neutral-100 outline-none focus:border-sky-600"
            value={effectiveAgent}
            onChange={(e) => onAgentChange(e.target.value)}
          >
            {agentIds.map((id) => (
              <option key={id} value={id}>
                {stoppedAgents.has(id) ? `${id} (not loaded)` : id}
              </option>
            ))}
          </select>
          {stoppedAgents.has(effectiveAgent) ? (
            <div className="mt-1 text-[10px] text-neutral-600">
              this agent is not materialized in the running server (e.g. created before a
              restart) — calls will fail; its persisted records remain on disk
            </div>
          ) : null}
          {meta.isError ? <div className="mt-1"><ErrorLine error={meta.error} /></div> : null}
        </div>
      ) : null}

      {/* Tabs */}
      <div className="flex border-b border-neutral-800 text-[11px]">
        {(['session', 'agent'] as const).map((t) => (
          <button
            key={t}
            className={`flex-1 px-2 py-2 font-medium uppercase tracking-wider ${
              tab === t ? 'bg-neutral-800 text-sky-400' : 'text-neutral-500 hover:text-neutral-300'
            }`}
            onClick={() => setTab(t)}
          >
            {t === 'session' ? 'Session' : 'Agent'}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {sessionBlocked ? (
          <div className="text-[12px] text-neutral-600">
            {sessionId === null ? 'No session selected.' : 'Loading session…'}
          </div>
        ) : tab === 'session' ? (
          <>
            <InteractionsCard sessionId={sessionId} />
            <ScopePanels scope="session" proxyFor={proxyFor} />
          </>
        ) : (
          <ScopePanels
            scope="agent"
            proxyFor={proxyFor}
            onError={(error) => noteAgentError(effectiveAgent, error)}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending interactions (approvals / questions) — fetched on demand: the
// session `interactions` push stream went away with `/api/v2/ws`, so the
// card refreshes only when Load is clicked.
// ---------------------------------------------------------------------------

interface PendingInteraction {
  readonly id: string;
  /** Known kinds: 'approval' | 'question' | 'user_tool'; other kinds may appear. */
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: number;
}

function InteractionsCard({ sessionId }: { sessionId: string }) {
  const { klient } = useConnection();
  const [pending, setPending] = useState<readonly PendingInteraction[]>([]);
  const [error, setError] = useState<unknown>(null);
  const interaction = klient.session(sessionId).service(ISessionInteractionService);
  const approval = klient.session(sessionId).service(ISessionApprovalService);
  const question = klient.session(sessionId).service(ISessionQuestionService);

  const reload = async () => {
    try {
      setError(null);
      setPending((await interaction.listPending()) as readonly PendingInteraction[]);
    } catch (error) {
      setError(error);
    }
  };

  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    try {
      await approval.decide(id, { decision });
      await reload();
    } catch (error) {
      setError(error);
    }
  };
  const answer = async (id: string, q: string, value: string) => {
    try {
      await question.answer(id, { answers: { [q]: value } });
      await reload();
    } catch (error) {
      setError(error);
    }
  };
  const dismiss = async (id: string) => {
    try {
      await question.dismiss(id);
      await reload();
    } catch (error) {
      setError(error);
    }
  };

  return (
    <div className="mb-3 rounded-lg border border-amber-900/50 bg-amber-950/20">
      <div className="flex items-center justify-between border-b border-amber-900/40 px-3 py-2">
        <span className="text-[12px] font-medium text-amber-200">
          Pending interactions {pending.length > 0 ? `(${pending.length})` : ''}
        </span>
        <ActionButton onClick={() => void reload()}>Load</ActionButton>
      </div>
      <div className="px-3 py-2">
        {error !== null ? <div className="mb-2"><ErrorLine error={error} /></div> : null}
        {pending.length === 0 ? (
          <div className="text-[11px] text-neutral-600 italic">
            nothing pending (click Load to check)
          </div>
        ) : (
          pending.map((item) => (
            <div key={item.id} className="mb-2 rounded border border-neutral-800 bg-neutral-950/60 p-2">
              <div className="mb-1 flex items-center gap-2">
                <Badge tone="amber">{item.kind}</Badge>
                <span className="font-mono text-[10px] text-neutral-500">{item.id}</span>
                <span className="text-[10px] text-neutral-600">{relTime(item.createdAt)}</span>
              </div>
              {item.kind === 'approval' ? (
                <>
                  <div className="mb-1.5 text-[11px] text-neutral-300">
                    <span className="text-neutral-500">tool </span>
                    {payloadField(item.payload, 'toolName', '?')}
                    <span className="text-neutral-500"> · </span>
                    {payloadField(item.payload, 'action', '')}
                  </div>
                  <JsonView data={item.payload['display'] ?? item.payload} />
                  <div className="mt-2 flex gap-1.5">
                    <ActionButton onClick={() => void decide(item.id, 'approved')}>Approve</ActionButton>
                    <ActionButton danger onClick={() => void decide(item.id, 'rejected')}>Reject</ActionButton>
                  </div>
                </>
              ) : item.kind === 'question' ? (
                <QuestionView
                  payload={item.payload}
                  onAnswer={(q, v) => void answer(item.id, q, v)}
                  onDismiss={() => void dismiss(item.id)}
                />
              ) : (
                <JsonView data={item.payload} />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function QuestionView({
  payload,
  onAnswer,
  onDismiss,
}: {
  payload: Record<string, unknown>;
  onAnswer: (question: string, value: string) => void;
  onDismiss: () => void;
}) {
  const questions = (payload['questions'] ?? []) as readonly {
    question: string;
    options?: readonly { label: string }[];
  }[];
  return (
    <>
      {questions.map((q) => (
        <div key={q.question} className="mb-1.5">
          <div className="mb-1 text-[11px] text-neutral-300">{q.question}</div>
          <div className="flex flex-wrap gap-1.5">
            {(q.options ?? []).map((opt) => (
              <ActionButton key={opt.label} onClick={() => onAnswer(q.question, opt.label)}>
                {opt.label}
              </ActionButton>
            ))}
            <ActionButton
              onClick={() => {
                const raw = window.prompt(q.question);
                if (raw !== null) onAnswer(q.question, raw);
              }}
            >
              Other…
            </ActionButton>
          </div>
        </div>
      ))}
      {questions.length === 0 ? <JsonView data={payload} /> : null}
      <div className="mt-1.5">
        <ActionButton danger onClick={onDismiss}>
          Dismiss
        </ActionButton>
      </div>
    </>
  );
}

/**
 * Render a wire payload field as display text: strings pass through,
 * numbers/booleans are stringified, anything else (or missing) falls back —
 * never "[object Object]".
 */
function payloadField(
  payload: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = payload[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}
