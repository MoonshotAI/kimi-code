/**
 * Right dock — the single right-hand column of the chat view. Merges what
 * used to be two separate columns (the transcript audit panel docked inside
 * the chat view, and the agent inspector on the far right) into one tabbed
 * column: `Audit` replays how the visible transcript store was built, entry
 * by entry; `Agent` hosts the agent switcher, the Plan lookup card, and the
 * agent Service panels; `State` reads the active agent's registered
 * plain-data state through `IAgentStateService.snapshot()` (the same live
 * diff-tree view as the session State tab in `SessionPane`, shared via
 * `StateCard`). Tabs switch with `hidden` instead of unmounting, so
 * panel-local state (the audit timeline position, Plan lookup input/results,
 * expanded Service panels, the state tree's open rows) survives tab
 * switches.
 */

import { useState } from 'react';

import { IAgentStateService } from '@moonshot-ai/agent-core-v2/agent/state/agentState';

import { useConnection } from '../connection';
import { Badge } from '../ui';
import type { AuditTrail } from '../audit/trail';
import { AuditPanel } from './audit/AuditPanel';
import { Inspector } from './Inspector';
import { StateCard } from './StateCard';

type Tab = 'audit' | 'agent' | 'state';

export function RightPanel({
  sessionId,
  agentId,
  onAgentChange,
  ready,
  trail,
}: {
  sessionId: string | null;
  agentId: string;
  onAgentChange: (agentId: string) => void;
  ready: boolean;
  /** The chat view's audit trail; null until its transcript channel exists. */
  trail: AuditTrail | null;
}) {
  const { klient } = useConnection();
  const [tab, setTab] = useState<Tab>('audit');

  return (
    <div className="flex h-full w-[440px] shrink-0 flex-col border-l border-neutral-800 bg-neutral-900/30">
      <div className="flex border-b border-neutral-800 text-[11px]">
        {(['audit', 'agent', 'state'] as const).map((t) => (
          <button
            key={t}
            className={`flex-1 px-2 py-2 font-medium uppercase tracking-wider ${
              tab === t ? 'bg-neutral-800 text-sky-400' : 'text-neutral-500 hover:text-neutral-300'
            }`}
            onClick={() => setTab(t)}
          >
            {t === 'audit' ? 'Audit' : t === 'agent' ? 'Agent' : 'State'}
          </button>
        ))}
      </div>
      <div className={tab === 'audit' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        {trail !== null ? (
          <AuditPanel trail={trail} />
        ) : (
          <div className="p-3 text-[12px] text-neutral-600">
            {sessionId === null
              ? 'No session selected.'
              : 'Loading transcript — the audit trail appears once the channel is up.'}
          </div>
        )}
      </div>
      <div className={tab === 'agent' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        <Inspector
          sessionId={sessionId}
          agentId={agentId}
          onAgentChange={onAgentChange}
          ready={ready}
        />
      </div>
      <div className={tab === 'state' ? 'min-h-0 flex-1 overflow-y-auto' : 'hidden'}>
        <div className="p-3">
          {sessionId === null || !ready ? (
            <div className="text-[12px] text-neutral-600">
              {sessionId === null ? 'No session selected.' : 'Loading session…'}
            </div>
          ) : (
            <StateCard
              id={`${sessionId}/${agentId}`}
              queryKey={['agentState', sessionId, agentId]}
              title="Agent state"
              label="agentStateService"
              badge={<Badge tone="sky">{agentId}</Badge>}
              fetchSnapshot={() =>
                klient.session(sessionId).agent(agentId).service(IAgentStateService).snapshot()
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
