import { LocalKaos } from '@moonshot-ai/kaos';

import type { AgentReplayRecord } from '../../rpc/resumed';
import { Agent } from '../index';
import type { AgentRecordPersistence } from '../records';
import type { ReplayRangeOptions } from '.';

export async function buildReplay(
  persistence: AgentRecordPersistence,
  range?: ReplayRangeOptions,
): Promise<readonly AgentReplayRecord[]> {
  const agent = new Agent({
    kaos: await LocalKaos.create(),
    persistence,
    type: 'sub',
    replay: { range },
  });
  await agent.resume({ rewriteMigratedRecords: false });
  return agent.replayBuilder.buildResult();
}
