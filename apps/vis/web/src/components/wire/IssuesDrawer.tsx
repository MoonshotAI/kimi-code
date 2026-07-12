import { useEffect } from 'react';

import type { Issue, IssueSeverity } from '../../lib/issues';
import { t } from '../../i18n';

interface IssuesDrawerProps {
  issues: Issue[];
  onClose: () => void;
  onJumpTo?: (lineNo: number) => void;
  /** Optional predicate: "is this line currently visible under the active
   *  filter?". When provided, jump buttons for filtered-out lines are
   *  disabled and flagged. */
  isLineVisible?: (lineNo: number) => boolean;
}

const SEV_COLOR: Record<IssueSeverity, string> = {
  error: 'var(--color-sev-error)',
  warning: 'var(--color-sev-warning)',
  info: 'var(--color-sev-info)',
};

function kindLabel(kind: Issue['kind']): string {
  switch (kind) {
    case 'orphan_tool_call': return t('wire.kindOrphanToolCall');
    case 'missing_tool_result': return t('wire.kindMissingToolResult');
    case 'tool_error': return t('wire.kindToolError');
    case 'tool_truncated': return t('wire.kindToolTruncated');
    case 'model_filtered': return t('wire.kindModelFiltered');
    case 'model_max_tokens': return t('wire.kindModelMaxTokens');
    case 'incomplete_step': return t('wire.kindIncompleteStep');
    case 'incomplete_compaction': return t('wire.kindIncompleteCompaction');
    case 'active_plan_mode': return t('wire.kindActivePlanMode');
    case 'rejected_approval': return t('wire.kindRejectedApproval');
    case 'wire_warning': return t('wire.kindWireWarning');
  }
}

export function IssuesDrawer({ issues, onClose, onJumpTo, isLineVisible }: IssuesDrawerProps) {
  // ESC closes — standard drawer affordance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <>
      <button
        type="button"
        aria-label={t('shared.close')}
        onClick={onClose}
        className="absolute inset-0 z-10 bg-black/20"
      />
      <aside
        className="absolute right-0 top-0 bottom-0 z-20 flex w-[360px] flex-col border-l border-border bg-surface-1 shadow-[-8px_0_32px_rgba(0,0,0,0.25)]"
        role="dialog"
        aria-label="issues"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2 font-mono text-[12px] text-fg-0">
          <span>
            {t('wire.issues')} <span className="text-fg-3">·</span>{' '}
            <span className="tabular text-fg-2">{issues.length}</span>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-[14px] text-fg-3 hover:text-fg-0"
            title={t('shared.close')}
          >
            ×
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {issues.length === 0 ? (
            <div className="p-6 font-mono text-[12px] text-fg-3">{t('wire.noIssues')}</div>
          ) : (
            <ul className="divide-y divide-border">
              {issues.map((iss, i) => (
                <IssueItem
                  key={`${iss.kind}-${iss.lineNo ?? 'w'}-${i}`}
                  issue={iss}
                  onJumpTo={onJumpTo}
                  onClose={onClose}
                  isLineVisible={isLineVisible}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}

function IssueItem({
  issue,
  onJumpTo,
  onClose,
  isLineVisible,
}: {
  issue: Issue;
  onJumpTo?: (lineNo: number) => void;
  onClose: () => void;
  isLineVisible?: (lineNo: number) => boolean;
}) {
  const color = SEV_COLOR[issue.severity];
  const lineNo = issue.lineNo;
  const hidden = lineNo !== null && isLineVisible !== undefined && !isLineVisible(lineNo);
  const canJump = lineNo !== null && onJumpTo !== undefined && !hidden;
  return (
    <li className="px-3 py-2 hover:bg-surface-2">
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <span
          className="inline-block h-[8px] w-[8px] shrink-0 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
        <span className="text-fg-1">{kindLabel(issue.kind)}</span>
        {lineNo !== null ? (
          <>
            <span className="text-fg-3">·</span>
            <span className="tabular text-fg-3">{t('context.line', { no: lineNo })}</span>
          </>
        ) : null}
        {hidden ? <span className="text-fg-3">({t('wire.filteredOut')})</span> : null}
        {lineNo !== null ? (
          <button
            type="button"
            disabled={!canJump}
            onClick={() => {
              if (canJump) onJumpTo?.(lineNo);
              onClose();
            }}
            className="ml-auto text-fg-3 hover:text-fg-0 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-fg-3"
            title={hidden ? t('wire.filteredOut') : t('wire.scrollToExpand')}
          >
            {t('wire.jump')} →
          </button>
        ) : null}
      </div>
      <div className="mt-1 break-words font-mono text-[12px] text-fg-0">{issue.summary}</div>
      {issue.detail !== undefined ? (
        <div className="mt-0.5 break-words font-mono text-[10.5px] text-fg-3">{issue.detail}</div>
      ) : null}
    </li>
  );
}
