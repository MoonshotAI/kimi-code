import { useAgentTree } from '../../hooks/useSubagents';
import { SubagentTree } from './SubagentTree';
import { t } from '../../i18n';

interface SubagentsTabProps {
  sessionId: string;
}

export function SubagentsTab({ sessionId }: SubagentsTabProps) {
  const { data, isLoading, error } = useAgentTree(sessionId);

  if (isLoading) {
    return <div className="p-6 font-mono text-[12px] text-fg-3">{t('subagents.loading')}</div>;
  }
  if (error) {
    return (
      <div className="p-6 font-mono text-[12px] text-[var(--color-sev-error)]">
        {(error as Error).message}
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <SubagentTree tree={data.tree} sessionId={sessionId} />
    </div>
  );
}
