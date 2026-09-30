import { useCleanup } from '@moonshot-ai/agent-core';
import {
  createCollection,
  currentUnit,
  lineage,
  type UnitNode,
} from '@moonshot-ai/agent-core/kernel/index';

import type { AgentProfile } from '../definition/types';

export interface SkippedAgentFile {
  readonly path: string;
  readonly reason: string;
}

export interface ProfileFinderContribution {
  readonly profiles: readonly AgentProfile[];
  readonly skipped?: readonly SkippedAgentFile[];
  readonly scannedRoots?: readonly string[];
}

export interface ProfileFinder {
  readonly sourceId: string;
  readonly priority?: number;
  readonly fatal?: boolean;
  load(): Promise<ProfileFinderContribution> | ProfileFinderContribution;
}

export const ProfileFinders = createCollection<ProfileFinder>('profiles.finders');

export function useProfileFinder(finder: ProfileFinder): void {
  useCleanup(
    ([...lineage(currentUnit())].at(-1) as UnitNode).contribute(ProfileFinders, finder, 0),
  );
}
