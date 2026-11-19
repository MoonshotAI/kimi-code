import type { Projection } from '#/store/replica';

export type Note = { readonly type: 'note'; readonly text: string };

export function note(text: string): Note {
  return { type: 'note', text };
}

export const texts: Projection<readonly string[], Note> = {
  initial: () => [],
  reduce: (state, { event }) => [...state, event.text],
};
