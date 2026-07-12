import { useState } from 'react';
import { t } from '../../i18n';

interface CopyButtonProps {
  value: string;
  label?: string;
  className?: string;
}

export function CopyButton({ value, label, className = '' }: CopyButtonProps) {
  const defaultLabel = t('shared.copy');
  const [state, setState] = useState<'idle' | 'ok' | 'err'>('idle');

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard
          .writeText(value)
          .then(() =>{  setState('ok'); })
          .catch(() =>{  setState('err'); })
          .finally(() => setTimeout(() =>{  setState('idle'); }, 1200));
      }}
      className={`font-mono text-[10px] text-fg-3 transition-colors hover:text-fg-1 ${className}`}
      title={t('shared.copyTitle', { value })}
    >
      {state === 'idle' ? (label ?? defaultLabel) : state === 'ok' ? t('shared.copied') : t('shared.copyErr')}
    </button>
  );
}
