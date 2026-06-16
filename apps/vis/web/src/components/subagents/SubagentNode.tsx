import { Link, useParams } from 'react-router-dom';
import type { AgentNode } from '../../types';
import { Pill, type PillTone } from '../shared/Pill';

const TYPE_TONE: Record<AgentNode['type'], PillTone> = {
  main: 'conversation',
  sub: 'subagent',
  independent: 'tools',
};

interface Props {
  node: AgentNode;
  sessionId: string;
}

export function SubagentNode({ node, sessionId }: Props) {
  const { agentId: activeAgentId } = useParams<{ agentId?: string }>();
  const selected = activeAgentId === node.agentId;
  const broken = !node.wireExists;

  return (
    <div className="my-1">
      <Link
        to={`/sessions/${sessionId}/agents/${node.agentId}`}
        className={[
          'relative flex items-start gap-3 border border-border bg-surface-0 px-3 py-2 transition-colors hover:bg-surface-1',
          selected ? 'border-[var(--color-cat-subagent)]' : '',
        ].join(' ')}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={TYPE_TONE[node.type]} variant="soft">
              {node.type}
            </Pill>
            <span className="font-mono text-[12px] text-fg-0">{node.agentId}</span>
            {node.swarmItem ? (
              <Pill tone="subagent" variant="outline" title={node.swarmItem}>
                {node.swarmItem}
              </Pill>
            ) : null}
            {node.parentAgentId !== null ? (
              <span className="font-mono text-[10.5px] text-fg-3">
                ← {node.parentAgentId}
              </span>
            ) : null}
            {broken ? (
              <Pill tone="warning" variant="outline">
                no wire
              </Pill>
            ) : null}
            <span className="ml-auto font-mono text-[10.5px] text-fg-3 tabular">
              {node.wireRecordCount} rec{node.wireRecordCount === 1 ? '' : 's'}
              {node.wireProtocolVersion !== null
                ? ` · v${node.wireProtocolVersion}`
                : ''}
            </span>
          </div>
          <div
            className="mt-1 truncate font-mono text-[10.5px] text-fg-3"
            title={node.homedir}
          >
            {node.homedir}
          </div>
        </div>
      </Link>
      {node.children.length > 0 ? (
        <div className="mt-1 border-l border-border pl-3 ml-3">
          {node.children.map((c) => (
            <SubagentNode key={c.agentId} node={c} sessionId={sessionId} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
