/**
 * Left icon rail — the app-level view switcher. Icon-only by design; view
 * names live in tooltips. Adding a view is one `VIEWS` entry here plus its
 * render branch in `App`.
 */

import type { ReactNode } from 'react';

export type AppView = 'chat' | 'search' | 'models' | 'services' | 'workspace' | 'bash' | 'di';

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
    id: 'search',
    title: 'Search',
    icon: (
      <svg {...iconProps}>
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
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
  {
    id: 'workspace',
    title: 'Workspace Runtime',
    icon: (
      <svg {...iconProps}>
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      </svg>
    ),
  },
  {
    id: 'bash',
    title: 'Bash Parser',
    icon: (
      <svg {...iconProps}>
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    ),
  },
  {
    id: 'di',
    title: 'DI',
    icon: (
      <svg {...iconProps}>
        <circle cx="18" cy="5" r="3" />
        <circle cx="6" cy="12" r="3" />
        <circle cx="18" cy="19" r="3" />
        <line x1="8.6" y1="10.5" x2="15.4" y2="6.5" />
        <line x1="8.6" y1="13.5" x2="15.4" y2="17.5" />
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
