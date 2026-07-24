/**
 * Left icon rail — the app-level view switcher. Icon-only by design; view
 * names live in tooltips. Adding a view is one `VIEWS` entry here plus its
 * render branch in `App`.
 */

import type { ReactNode } from 'react';

export type AppView = 'chat' | 'models' | 'services';

interface ViewDef {
  readonly id: AppView;
  readonly title: string;
  readonly icon: ReactNode;
}

const iconProps = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const VIEWS: readonly ViewDef[] = [
  {
    id: 'chat',
    title: 'Chat',
    icon: (
      <svg {...iconProps}>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    id: 'models',
    title: 'Model Catalog',
    icon: (
      <svg {...iconProps}>
        <path d="M12 2 2 7l10 5 10-5-10-5z" />
        <path d="m2 17 10 5 10-5" />
        <path d="m2 12 10 5 10-5" />
      </svg>
    ),
  },
  {
    id: 'services',
    title: 'App Services',
    icon: (
      <svg {...iconProps}>
        <rect x="2" y="2" width="20" height="8" rx="2" />
        <rect x="2" y="14" width="20" height="8" rx="2" />
        <line x1="6" y1="6" x2="6.01" y2="6" />
        <line x1="6" y1="18" x2="6.01" y2="18" />
      </svg>
    ),
  },
];

export function NavRail({
  view,
  onChange,
}: {
  readonly view: AppView;
  readonly onChange: (view: AppView) => void;
}) {
  return (
    <nav className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-neutral-800 py-2">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          title={v.title}
          aria-label={v.title}
          onClick={() => {
            onChange(v.id);
          }}
          className={`rounded-md p-2 transition-colors ${
            view === v.id
              ? 'bg-neutral-800 text-sky-400'
              : 'text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-300'
          }`}
        >
          {v.icon}
        </button>
      ))}
    </nav>
  );
}
