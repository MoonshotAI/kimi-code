import type { AgentRecord } from '../../types';
import { Dim, type HeadlineRender } from './parts';
import { rendererFor } from './renderers';

export type { HeadlineRender };

/** Render the collapsed-headline for a wire record. Thin dispatch to the
 *  per-kind registry; unknown runtime kinds (best-effort parse of a
 *  future/legacy/foreign protocol) get a generic fallback so the row never
 *  crashes the tab. */
export function renderHeadline(r: AgentRecord): HeadlineRender {
  const renderer = rendererFor(r.type);
  if (renderer !== undefined) return renderer.headline(r);
  return {
    main: <Dim>(unknown record type: {(r as { type: string }).type})</Dim>,
  };
}
