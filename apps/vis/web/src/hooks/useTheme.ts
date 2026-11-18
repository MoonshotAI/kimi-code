import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'auto';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'vis.theme';

function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

function readStored(): ThemeChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'auto') return v;
  } catch {}
  return 'auto';
}

function apply(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    meta.content = resolved === 'light' ? '#fafbfc' : '#0b0d12';
  }
}

export function useTheme(): {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  cycle: () => void;
  set: (c: ThemeChoice) => void;
} {
  const [choice, setChoice] = useState<ThemeChoice>(() => readStored());
  const [sys, setSys] = useState<ResolvedTheme>(() => systemTheme());

  useEffect(() => {
    const m = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () =>{  setSys(m.matches ? 'light' : 'dark'); };
    m.addEventListener('change', handler);
    return () =>{  m.removeEventListener('change', handler); };
  }, []);

  const resolved: ResolvedTheme = choice === 'auto' ? sys : choice;

  useEffect(() => {
    apply(resolved);
  }, [resolved]);

  const set = useCallback((c: ThemeChoice) => {
    setChoice(c);
    try {
      if (c === 'auto') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, c);
    } catch {}
  }, []);

  const cycle = useCallback(() => {
    const next: ThemeChoice =
      choice === 'auto' ? 'light' : choice === 'light' ? 'dark' : 'auto';
    set(next);
  }, [choice, set]);

  return { choice, resolved, cycle, set };
}
