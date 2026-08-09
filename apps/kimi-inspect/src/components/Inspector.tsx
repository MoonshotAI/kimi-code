/**
 * Agent inspector — the `Agent` tab of the chat view's right dock
 * (`RightPanel`; it used to be a standalone 420px column on the far right).
 * Hosts the agent switcher, the Plan lookup card, and the agent Service
 * panels (`ScopePanels`). The session scope lives in the `SessionPane`
 * column next to the sidebar (pending interactions, session Services,
 * session State); the app-scope (server-level) Services live in their own
 * rail view (`AppServicesView`), not here.
 *
 * Everything here is fetch-on-demand (Load / Refresh buttons): the v2 event
 * socket (`/api/v2/ws`) that used to push core/session/agent event streams
 * — live panel refetches, the pending-interaction push, the merged event
 * log — was removed server-side, so there is no live push to render.
 */

import { ISessionMetadata } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { serviceByName } from '../channel';
import { useConnection } from '../connection';
import { type AnyService } from '../panels';
import { fetchTranscriptPlan, type TranscriptPlanInfo } from '../transcript/api';
import { ActionButton, Badge, ErrorLine } from '../ui';
import { ScopePanels } from './ServicePanels';

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

  const meta = useQuery({
    queryKey: ['sessionMeta', sessionId],
    queryFn: () =>
      klient
        .session(sessionId as string)
        .service(ISessionMetadata)
        .read(),
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
      return (
        serviceByName<AnyService>(klient, name, {
          scope: 'agent',
          sessionId: sessionId !== null && ready ? sessionId : undefined,
          agentId: effectiveAgent,
        }) ?? null
      );
    };
  }, [klient, sessionId, effectiveAgent, ready]);

  const sessionBlocked = sessionId === null || !ready;

  return (
    <div className="flex h-full flex-col">
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
              this agent is not materialized in the running server (e.g. created before a restart) —
              calls will fail; its persisted records remain on disk
            </div>
          ) : null}
          {meta.isError ? (
            <div className="mt-1">
              <ErrorLine error={meta.error} />
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto p-3">
        {sessionBlocked ? (
          <div className="text-[12px] text-neutral-600">
            {sessionId === null ? 'No session selected.' : 'Loading session…'}
          </div>
        ) : (
          <>
            <PlanCard sessionId={sessionId} agentId={effectiveAgent} />
            <ScopePanels
              scope="agent"
              proxyFor={proxyFor}
              onError={(error) => noteAgentError(effectiveAgent, error)}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan lookup — `GET /api/v1/sessions/{id}/transcript/plan`: the reviewed plan
// of one ExitPlanMode tool call, queried by tool_call_id (copy it from a tool
// frame in the chat view). Read-only, fetched on demand like everything else
// here.
// ---------------------------------------------------------------------------

function PlanCard({ sessionId, agentId }: { sessionId: string; agentId: string }) {
  const { baseUrl, config } = useConnection();
  const [toolCallId, setToolCallId] = useState('');
  const [result, setResult] = useState<readonly TranscriptPlanInfo[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  // A plan belongs to one agent's transcript — stale results from another
  // session/agent are misleading, so reset on switch.
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [sessionId, agentId]);

  const query = async () => {
    setLoading(true);
    try {
      setError(null);
      const token = config.token.trim();
      const id = toolCallId.trim();
      setResult(
        await fetchTranscriptPlan({
          baseUrl,
          token: token === '' ? undefined : token,
          sessionId,
          agentId,
          toolCallId: id === '' ? undefined : id,
        }),
      );
    } catch (error) {
      setResult(null);
      setError(error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-950/40">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <span className="text-[12px] font-medium text-neutral-200">Plan lookup</span>
        <Badge tone="sky">{agentId}</Badge>
      </div>
      <div className="px-3 py-2">
        <div className="flex gap-1.5">
          <input
            className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-[11px] text-neutral-100 outline-none focus:border-sky-600"
            placeholder="tool_call_id (empty = all plans)"
            value={toolCallId}
            onChange={(e) => setToolCallId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void query();
            }}
          />
          <ActionButton disabled={loading} onClick={() => void query()}>
            {loading ? 'Loading…' : 'Query'}
          </ActionButton>
        </div>
        {error !== null ? (
          <div className="mt-2">
            <ErrorLine error={error} />
          </div>
        ) : null}
        {result !== null ? (
          result.length === 0 ? (
            <div className="mt-2 text-[11px] text-neutral-600 italic">no plans on this agent</div>
          ) : (
            result.map((entry) => <PlanEntryView key={entry.toolCallId} entry={entry} />)
          )
        ) : null}
      </div>
    </div>
  );
}

function PlanEntryView({ entry }: { entry: TranscriptPlanInfo }) {
  const review = entry.review;
  return (
    <div className="mt-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[10px] text-neutral-400 select-all">
          {entry.toolCallId}
        </span>
        <Badge tone="neutral">{entry.source}</Badge>
        {review !== undefined ? (
          <Badge
            tone={
              review.state === 'approved' ? 'green' : review.state === 'pending' ? 'amber' : 'red'
            }
          >
            {review.state}
          </Badge>
        ) : null}
        <span className="font-mono text-[10px] text-neutral-500">{entry.turnId}</span>
      </div>
      {entry.path !== undefined ? (
        <div className="mb-1 break-all font-mono text-[10px] text-neutral-500">{entry.path}</div>
      ) : null}
      {review?.selectedOption !== undefined ? (
        <div className="mb-1 text-[11px] text-neutral-400">
          <span className="text-neutral-600">selected: </span>
          {review.selectedOption}
        </div>
      ) : null}
      {review?.feedback !== undefined ? (
        <div className="mb-1 text-[11px] text-neutral-400">
          <span className="text-neutral-600">feedback: </span>
          {review.feedback}
        </div>
      ) : null}
      {entry.options !== undefined ? (
        <div className="mb-1 flex flex-wrap gap-1.5">
          {entry.options.map((option) => (
            <Badge key={option.label} tone="violet">
              {option.label}
            </Badge>
          ))}
        </div>
      ) : null}
      <pre className="max-h-72 overflow-auto rounded border border-neutral-800 bg-neutral-950 p-2 text-[11px] whitespace-pre-wrap text-neutral-300">
        {entry.plan}
      </pre>
    </div>
  );
}
