import { LocalKaos } from '@moonshot-ai/kaos';

import type { AgentReplayRecord } from '../../rpc/resumed';
import { Agent } from '../index';
import type { AgentRecordPersistence } from '../records';

export async function buildReplay(
  persistence: AgentRecordPersistence,
  start?: number,
  count?: number,
): Promise<readonly AgentReplayRecord[]> {
  if (count === 0) return [];
  const replay = start === undefined && count === undefined
    ? undefined
    : { range: { start, count } };

  const agent = new Agent({
    kaos: await LocalKaos.create(),
    persistence,
    type: 'sub',
    replay,
  });
  await agent.records.replay({
    rewriteMigratedRecords: false,
  });
  return agent.replayBuilder.buildResult();
}
