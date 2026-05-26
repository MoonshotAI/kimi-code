import { Link, useParams } from 'react-router-dom';
import { useSession } from '../hooks/useSession';
import { TabBar, useActiveTab } from '../components/layout/TabBar';
import { ContextTab } from '../components/context/ContextTab';
import { WireTab } from '../components/wire/WireTab';
import { Pill, type PillTone } from '../components/shared/Pill';
import type { AgentInfo } from '../types';

type TabId = 'wire' | 'context';

const TYPE_TONE: Record<AgentInfo['type'], PillTone> = {
  main: 'conversation',
  sub: 'subagent',
  independent: 'tools',
};

export function SubagentDetailPage() {
  const { sessionId, agentId } = useParams<{ sessionId: string; agentId: string }>();
  const active = useActiveTab('wire') as TabId;
  const { data: detail, isLoading, error } = useSession(sessionId);

  if (!sessionId || !agentId) return null;
  if (isLoading) {
    return <div className="p-6 font-mono text-[12px] text-fg-3">loading agent…</div>;
  }
  if (error) {
    return (
      <div className="p-6 font-mono text-[12px] text-[var(--color-sev-error)]">
        {(error as Error).message}
      </div>
    );
  }
  if (!detail) return null;

  const agent = detail.agents.find((a) => a.agentId === agentId) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Breadcrumb + header */}
      <div className="shrink-0 border-b border-border bg-surface-1 px-4 py-3">
        <div className="flex items-center gap-2 font-mono text-[11px] text-fg-2">
          <Link
            to={`/sessions/${sessionId}?tab=agents`}
            className="hover:text-fg-0"
          >
            ‹ back to agents
          </Link>
          <span className="text-fg-3">·</span>
          <Link to={`/sessions/${sessionId}`} className="hover:text-fg-0">
            session
          </Link>
          <span className="text-fg-3">›</span>
          <span className="text-fg-0">{agentId}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="font-mono text-[14px] text-fg-0">{agentId}</span>
          {agent !== null ? (
            <>
              <Pill tone={TYPE_TONE[agent.type]} variant="soft">
                {agent.type}
              </Pill>
              {agent.parentAgentId !== null ? (
                <span className="font-mono text-[11px] text-fg-3">
                  parent ·{' '}
                  <Link
                    to={`/sessions/${sessionId}/agents/${agent.parentAgentId}`}
                    className="text-fg-1 hover:text-fg-0"
                  >
                    {agent.parentAgentId}
                  </Link>
                </span>
              ) : null}
              <span className="font-mono text-[11px] text-fg-3 tabular">
                {agent.wireRecordCount} record
                {agent.wireRecordCount === 1 ? '' : 's'}
                {agent.wireProtocolVersion !== null
                  ? ` · v${agent.wireProtocolVersion}`
                  : ''}
              </span>
              {!agent.wireExists ? (
                <Pill tone="warning" variant="outline">
                  no wire
                </Pill>
              ) : null}
            </>
          ) : (
            <Pill tone="error" variant="outline">
              agent not found
            </Pill>
          )}
        </div>
      </div>

      <TabBar
        defaultTab="wire"
        tabs={[
          { id: 'wire', label: 'Wire', count: agent?.wireRecordCount ?? null },
          { id: 'context', label: 'Context', count: null },
        ]}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        {active === 'wire' ? (
          agent === null || !agent.wireExists ? (
            <Centered>no wire records for this agent</Centered>
          ) : (
            <WireTab sessionId={sessionId} initialAgentId={agentId} />
          )
        ) : null}

        {active === 'context' ? (
          agent === null || !agent.wireExists ? (
            <Centered>no context for this agent</Centered>
          ) : (
            <ContextTab sessionId={sessionId} initialAgentId={agentId} />
          )
        ) : null}
      </div>
    </div>
  );
}

function Centered({ children }: { children: import('react').ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6 font-mono text-[12px] text-fg-3">
      {children}
    </div>
  );
}
