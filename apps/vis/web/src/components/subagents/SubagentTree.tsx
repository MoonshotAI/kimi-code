import type { AgentNode } from '../../types';
import { t } from '../../i18n';
import { SubagentNode } from './SubagentNode';

interface SubagentTreeProps {
  tree: AgentNode[];
  sessionId: string;
}

export function SubagentTree({ tree, sessionId }: SubagentTreeProps) {
  if (tree.length === 0) {
    return (
      <div className="p-6 font-mono text-[12px] text-fg-3">
        {t('subagentTree.noAgents')}
      </div>
    );
  }
  return (
    <div className="p-3">
      {tree.map((node) => (
        <SubagentNode key={node.agentId} node={node} sessionId={sessionId} />
      ))}
    </div>
  );
}
