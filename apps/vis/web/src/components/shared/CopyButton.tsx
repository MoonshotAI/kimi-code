import { useState } from 'react';

interface CopyButtonProps {
  value: string;
  label?: string;
  className?: string;
  title?: string;
}

export function CopyButton({ value, label = 'copy', className = '', title }: CopyButtonProps) {
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
      title={title ?? `Copy ${value}`}
    >
      {state === 'idle' ? label : state === 'ok' ? '✓ copied' : '✗ err'}
    </button>
  );
}
