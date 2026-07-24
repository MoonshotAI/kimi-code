/**
 * Right dock — the single right-hand column of the chat view. Merges what
 * used to be two separate columns (the transcript audit panel docked inside
 * the chat view, and the agent inspector on the far right) into one tabbed
 * column: `Audit` replays how the visible transcript store was built, entry
 * by entry; `Agent` hosts the agent switcher, the Plan lookup card, and the
 * agent Service panels. Tabs switch with `hidden` instead of unmounting, so
 * panel-local state (the audit timeline position, Plan lookup input/results,
 * expanded Service panels) survives tab switches.
 */

import { useState } from 'react';

import type { AuditTrail } from '../audit/trail';
import { AuditPanel } from './audit/AuditPanel';
import { Inspector } from './Inspector';

type Tab = 'audit' | 'agent';

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
  const [tab, setTab] = useState<Tab>('audit');

  return (
    <div className="flex h-full w-[440px] shrink-0 flex-col border-l border-neutral-800 bg-neutral-900/30">
      <div className="flex border-b border-neutral-800 text-[11px]">
        {(['audit', 'agent'] as const).map((t) => (
          <button
            key={t}
            className={`flex-1 px-2 py-2 font-medium uppercase tracking-wider ${
              tab === t ? 'bg-neutral-800 text-sky-400' : 'text-neutral-500 hover:text-neutral-300'
            }`}
            onClick={() => setTab(t)}
          >
            {t === 'audit' ? 'Audit' : 'Agent'}
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
    </div>
  );
}
