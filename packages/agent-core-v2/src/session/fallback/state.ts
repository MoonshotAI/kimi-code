import { defineState } from '#/state/state';

export interface ActiveFallbackModel {
  readonly alias: string;
  readonly tier: 'primary' | 'secondary';
}

export const fallbackModelActiveKey = defineState<ActiveFallbackModel | undefined>(
  'fallbackModel.active',
  () => undefined,
);
