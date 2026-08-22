/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { Event2 } from '#/app/event/event2';

export class PluginChanged extends Event2<{ readonly payload: Record<string, never> }> {
  static override readonly type = 'event.plugin.changed';
}
export interface PluginChanged {
  readonly payload: Record<string, never>;
}
