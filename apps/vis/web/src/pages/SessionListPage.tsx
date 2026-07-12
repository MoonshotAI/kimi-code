import { useSessions } from '../hooks/useSession';
import { t } from '../i18n';

export function SessionListPage() {
  const { data } = useSessions();
  const count = data?.length ?? 0;

  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-md px-8 text-center">
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-fg-3">
          kimi vis
        </div>
        <div className="mt-3 font-mono text-[13px] text-fg-1">
          {t('sessionList.selectPrompt')}
        </div>
        <div className="mt-6 flex items-center justify-center gap-6 font-mono text-[11px] text-fg-2">
          <div>
            <div className="tabular text-[22px] text-fg-0">{count}</div>
            <div className="text-fg-3">{t('sessionList.sessions')}</div>
          </div>
        </div>
        <div className="mt-10 space-y-1 text-left font-mono text-[10.5px] text-fg-3">
          <div>
            <kbd className="mr-2 border border-border px-1 text-fg-2">/</kbd>
            {t('sessionList.focusSearch')}
          </div>
          <div>
            <kbd className="mr-2 border border-border px-1 text-fg-2">esc</kbd>
            {t('sessionList.closeDrawers')}
          </div>
        </div>
      </div>
    </div>
  );
}
