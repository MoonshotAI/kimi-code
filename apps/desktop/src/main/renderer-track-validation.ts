import {
  rendererTrackEventSchema,
  type RendererTrackEvent,
} from '../shared/track-events';

export function asRendererTrackEvent(
  event: unknown,
  payload: unknown,
): RendererTrackEvent | null {
  const result = rendererTrackEventSchema.safeParse({ event, properties: payload });
  return result.success ? result.data : null;
}
