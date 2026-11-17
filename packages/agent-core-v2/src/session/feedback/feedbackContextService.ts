import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

import {
  FeedbackModelRequestRecorded,
  ISessionFeedbackContextService,
  type FeedbackParticipantModel,
  type FeedbackTurnContext,
} from './feedbackContext';

interface OrderedFact {
  readonly agentId: string;
  readonly rootTurnId: number;
  readonly turnId: number;
  readonly step: number;
  readonly model: string;
  readonly provider: string;
  readonly traceId?: string;
  readonly time: number;
  readonly index: number;
}

export class SessionFeedbackContextService extends Service implements ISessionFeedbackContextService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAppendLogStore private readonly logs: IAppendLogStore,
    @ISessionContext private readonly context: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
  ) {
    super();
  }

  async read(rootTurnId: number): Promise<FeedbackTurnContext | undefined> {
    await this.logs.flush();
    const agents = new Set([
      MAIN_AGENT_ID,
      ...Object.keys((await this.metadata.read()).agents ?? {}),
    ]);
    const facts: OrderedFact[] = [];
    for (const agentId of agents) {
      const scope = this.context.scope(`agents/${agentId}`);
      let index = 0;
      for await (const record of this.logs.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY)) {
        const fact = readFact(record, agentId, index);
        index += 1;
        if (fact?.rootTurnId === rootTurnId) facts.push(fact);
      }
    }
    const main = facts
      .filter((fact) => fact.agentId === MAIN_AGENT_ID)
      .toSorted(compareMainFacts)
      .at(-1);
    if (main === undefined) return undefined;
    const participants = new Map<string, FeedbackParticipantModel>();
    for (const fact of facts.toSorted(compareFacts)) {
      const key = JSON.stringify([fact.model, fact.provider]);
      if (!participants.has(key)) participants.set(key, { model: fact.model, provider: fact.provider });
    }
    return {
      model: main.model,
      provider: main.provider,
      traceId: main.traceId,
      participantModels: [...participants.values()],
    };
  }
}

function readFact(record: WireRecord, agentId: string, index: number): OrderedFact | undefined {
  if (record.type !== FeedbackModelRequestRecorded.type) return undefined;
  const { type: _type, time, ...payload } = record;
  const parsed = FeedbackModelRequestRecorded.schema.safeParse(payload);
  if (!parsed.success || parsed.data.agentId !== agentId) return undefined;
  return { ...parsed.data, time: typeof time === 'number' ? time : 0, index };
}

function compareMainFacts(a: OrderedFact, b: OrderedFact): number {
  return a.step - b.step || a.time - b.time || a.index - b.index;
}

function compareFacts(a: OrderedFact, b: OrderedFact): number {
  return a.time - b.time || a.agentId.localeCompare(b.agentId) || a.index - b.index;
}

registerScopedService(
  LifecycleScope.Session,
  ISessionFeedbackContextService,
  SessionFeedbackContextService,
  ScopeActivation.OnDemand,
  'feedbackContext',
);
