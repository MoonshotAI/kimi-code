import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { SessionRail } from '../sessions/SessionRail';
import { ZipDropOverlay } from '../shared/ZipDropOverlay';
import { useTheme, type ThemeChoice, type ResolvedTheme } from '../../hooks/useTheme';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const qc = useQueryClient();
  const { choice, resolved, cycle } = useTheme();

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-surface-1 px-4">
        <Link to="/" className="flex items-center gap-2">
          <LogoMark />
          <span className="font-mono text-[12px] uppercase tracking-[0.12em] text-fg-0">
            kimi <span className="text-fg-2">vis</span>
          </span>
          <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">
            debug · local files
          </span>
        </Link>
        <div className="flex items-center gap-2 text-[11px] text-fg-2">
          <ThemeToggle choice={choice} resolved={resolved} onCycle={cycle} />
          <button
            onClick={() => {
              void qc.invalidateQueries();
            }}
            className="flex items-center gap-1.5 border border-border px-2 py-0.5 font-mono text-[11px] text-fg-1 transition-colors hover:border-border-strong hover:text-fg-0"
            title="Refresh — re-read all session data from disk"
          >
            <RefreshIcon />
            refresh
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <SessionRail />
        {/* min-w-0 lets the main column shrink below its content's intrinsic
            width; without it a flex child defaults to min-width:auto and wide
            tab content (e.g. the Timeline's flex-wrap rows) blows the layout
            out horizontally instead of wrapping. */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
      </div>
      <ZipDropOverlay />
    </div>
  );
}

function ThemeToggle({
  choice,
  resolved,
  onCycle,
}: {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  onCycle: () => void;
}) {
  const label = choice === 'auto' ? `auto · ${resolved}` : choice;
  const title = `Theme: ${label}. Click to cycle (auto → light → dark → auto).`;
  return (
    <button
      onClick={onCycle}
      className="flex items-center gap-1.5 border border-border px-2 py-0.5 font-mono text-[11px] text-fg-1 transition-colors hover:border-border-strong hover:text-fg-0"
      title={title}
      aria-label={`Theme ${label}`}
    >
      {choice === 'auto' ? <AutoIcon /> : resolved === 'light' ? <SunIcon /> : <MoonIcon />}
      <span className="tabular">{label}</span>
    </button>
  );
}

function LogoMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1" y="1" width="6" height="6" fill="var(--color-cat-conversation)" />
      <rect x="9" y="1" width="6" height="6" fill="var(--color-cat-subagent)" />
      <rect x="1" y="9" width="6" height="6" fill="var(--color-cat-ephemeral)" />
      <rect x="9" y="9" width="6" height="6" fill="var(--color-cat-approval)" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M10 3 A5 5 0 1 0 10.8 7"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
        strokeLinecap="square"
      />
      <path d="M7 1 L10 3 L7 5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r="2" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="1" strokeLinecap="round">
        <line x1="6" y1="0.5" x2="6" y2="2" />
        <line x1="6" y1="10" x2="6" y2="11.5" />
        <line x1="0.5" y1="6" x2="2" y2="6" />
        <line x1="10" y1="6" x2="11.5" y2="6" />
        <line x1="2" y1="2" x2="3" y2="3" />
        <line x1="9" y1="9" x2="10" y2="10" />
        <line x1="10" y1="2" x2="9" y2="3" />
        <line x1="3" y1="9" x2="2" y2="10" />
      </g>
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M9 7.5 A4.5 4.5 0 1 1 4.5 3 A3.6 3.6 0 0 0 9 7.5 Z"
        fill="currentColor"
      />
    </svg>
  );
}

function AutoIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M6 1 A5 5 0 1 1 6 11 Z"
        fill="currentColor"
      />
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
