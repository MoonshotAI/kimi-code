/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { Event2 } from '#/app/event/event2';

import type { CapabilityId, CapabilityInstallProgress } from './types';

export interface CapabilityChangedPayload {
  readonly capability_id: CapabilityId;
  readonly install: CapabilityInstallProgress;
}

export class CapabilityChanged extends Event2<{ readonly payload: CapabilityChangedPayload }> {
  static override readonly type = 'event.capability.changed';
}
export interface CapabilityChanged {
  readonly payload: CapabilityChangedPayload;
}
