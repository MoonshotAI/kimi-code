import type { AgentRecord } from '../../types';
import { Dim, type HeadlineRender } from './parts';
import { rendererFor } from './renderers';

export type { HeadlineRender };

export function renderHeadline(r: AgentRecord): HeadlineRender {
  const renderer = rendererFor(r.type);
  if (renderer !== undefined) return renderer.headline(r);
  return {
    main: <Dim>(unknown record type: {(r as { type: string }).type})</Dim>,
  };
}
