import { ref, type Ref } from 'vue';

export type LocalFontsState = 'idle' | 'querying' | 'ready' | 'unavailable';

export function filterFontFamilies(families: readonly string[], text: string): string[] {
  const needle = text.trim().toLowerCase();
  return families.filter((family) => family.toLowerCase().includes(needle));
}

export interface LocalFontFace {
  family?: unknown;
  style?: unknown;
  fullName?: unknown;
  postscriptName?: string;
  blob?: () => Promise<Blob>;
}

interface QueryLocalFontsWindow {
  queryLocalFonts?: () => Promise<LocalFontFace[]>;
}

const representatives = new Map<string, LocalFontFace>();
const searchNames = new Map<string, Set<string>>();

export function getLocalFontFace(family: string): LocalFontFace | undefined {
  return representatives.get(family);
}

export function localFontSearchNames(family: string): ReadonlySet<string> {
  return searchNames.get(family) ?? new Set();
}

const families = ref<string[]>([]);
const state = ref<LocalFontsState>('idle');

function isUprightStyle(face: LocalFontFace): boolean {
  return typeof face.style === 'string' && /^(regular|normal|roman|book)$/i.test(face.style);
}

async function query(): Promise<void> {
  const win = globalThis.window as QueryLocalFontsWindow | undefined;
  if (typeof win?.queryLocalFonts !== 'function') {
    state.value = 'unavailable';
    return;
  }
  state.value = 'querying';
  try {
    const fonts = await win.queryLocalFonts();
    representatives.clear();
    searchNames.clear();
    const set = new Set<string>();
    for (const face of fonts) {
      if (typeof face?.family !== 'string' || face.family === '') continue;
      set.add(face.family);
      if (typeof face.fullName === 'string' && face.fullName !== '') {
        const names = searchNames.get(face.family);
        const name = face.fullName.toLowerCase();
        if (names === undefined) searchNames.set(face.family, new Set([name]));
        else names.add(name);
      }
      const previous = representatives.get(face.family);
      if (previous === undefined || isUprightStyle(face)) representatives.set(face.family, face);
    }
    families.value = [...set].sort((a, b) => a.localeCompare(b));
    state.value = 'ready';
  } catch {
    representatives.clear();
    searchNames.clear();
    state.value = 'unavailable';
  }
}

interface PermissionsLike {
  query?: (descriptor: { name: string }) => Promise<{ state: string }>;
}

export async function ensureLocalFontsIfPermitted(): Promise<void> {
  if (state.value !== 'idle') return;
  const nav = globalThis.navigator as { permissions?: PermissionsLike } | undefined;
  if (typeof nav?.permissions?.query !== 'function') return;
  try {
    const status = await nav.permissions.query({ name: 'local-fonts' });
    if (status.state === 'granted' && state.value === 'idle') await query();
  } catch {
    return;
  }
}

export function useLocalFonts(): {
  localFontFamilies: Ref<string[]>;
  localFontsState: Ref<LocalFontsState>;
  ensureLocalFonts: () => void;
} {
  function ensureLocalFonts(): void {
    if (state.value === 'idle') void query();
  }
  return { localFontFamilies: families, localFontsState: state, ensureLocalFonts };
}
