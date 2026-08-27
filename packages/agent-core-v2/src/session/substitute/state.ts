import { defineState } from '#/state/state';

export interface ActiveSubstituteModel {
  readonly alias: string;
  readonly primaryAlias: string;
  readonly until: number;
}

export const substituteModelActiveKey = defineState<ActiveSubstituteModel | undefined>(
  'substituteModel.active',
  () => undefined,
);
