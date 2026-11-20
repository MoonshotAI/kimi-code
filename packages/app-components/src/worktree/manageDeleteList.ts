import type { WorktreeRemovalState } from '@moonshot-ai/app-client/stores';

export interface ManageDeleteListItem {
  key: string;
  name: string;
  nameIsDirectory: boolean;
  meta?: string;
  loss?: string;
  state?: WorktreeRemovalState;
  stateText?: string;
}

export const MANAGE_DELETE_LIST_NATURAL_ROWS = 3;
