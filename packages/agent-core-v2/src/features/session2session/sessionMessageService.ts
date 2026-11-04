import type { IAgentScopeHandle, ISessionScopeHandle } from '#/_base/di/scope';
import { IInstantiationService } from '#/_base/di/instantiation';
import { sliceOnCodePointBoundary } from '#/_base/text/code-points';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { newMessageId } from '#/agent/contextMemory/messageId';
import type { ContextMessage, SessionMessageOrigin } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { foldWireRecords } from '#/agent/replayBuilder/fold';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { resumeSessionById } from '#/app/sessionManager/sessionLookup';
import { ErrorCodes, isError2, SessionErrors } from '#/errors';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { getOrRestoreAgent } from '#/session/agentLifecycle/getOrRestoreAgent';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  agentScopeOf,
  sessionDirOf,
  sessionScopeOf,
  workspacePersistenceScope,
} from '#/workspace/sessionLifecycle/internal/addressing';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { fromPersistentWireRecord } from '#/wire/wireService';

import {
  ISessionMessageService,
  type SessionDeliveryStatus,
  type SessionListEntry,
  type SessionListStatus,
  type SessionMessageFailure,
  type SessionCreateInput,
  type SessionCreateResult,
  type SessionReadInput,
  type SessionReadResult,
  type SessionSendInput,
  type SessionSendResult,
} from './session2session';
import { SessionMessageSent } from './sessionMessageEvents';

const SESSION_PAGE_SIZE = 200;

class SessionDeliveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly candidates?: readonly SessionListEntry[],
  ) {
    super(message);
    this.name = 'SessionDeliveryError';
  }
}

export class SessionMessageService implements ISessionMessageService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IAgentScopeContext private readonly agentScope: IAgentScopeContext,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IWireService private readonly wire: IWireService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ISessionManager private readonly sessions: ISessionManager,
    @ISessionIndex private readonly index: ISessionIndex,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAppendLogStore private readonly appendLog: IAppendLogStore,
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {}

  async send(input: SessionSendInput): Promise<SessionSendResult> {
    const messageId = newMessageId();
    try {
      let original: SessionMessageOrigin | undefined;
      if (input.replyTo !== undefined) {
        original = await this.findReceivedMessage(input.replyTo);
        if (original === undefined) {
          throw new SessionDeliveryError(
            'SESSION_MESSAGE_NOT_FOUND',
            `Unknown replyTo "${input.replyTo}". 请使用收到消息信封里的 messageId。`,
          );
        }
      }
      const target = await this.resolveTarget(input.to);
      const fromTitle = (await this.sessionMetadata.read()).title ?? this.sessionContext.sessionId;
      const origin: SessionMessageOrigin = {
        kind: 'session_message',
        messageId,
        fromSessionId: this.sessionContext.sessionId,
        fromTitle,
        replyTo: original?.messageId,
        chainId: original?.chainId ?? newMessageId(),
        expectReply: input.expectReply ?? false,
      };
      const status = await this.deliver(target, input.message, origin, input.delivery);
      await this.recordSent(target.id, input.message, origin);
      return { messageId, status };
    } catch (error) {
      return failure(error);
    }
  }

  async read(input: SessionReadInput): Promise<SessionReadResult> {
    try {
      const target = await this.resolveTargetSummary(input.to);
      const latestAssistant = await this.latestAssistant(target, input.limit ?? 2_000);
      return {
        id: target.id,
        title: target.title ?? target.id,
        status: this.status(target),
        latestAssistant,
      };
    } catch (error) {
      return failure(error);
    }
  }

  async create(input: SessionCreateInput): Promise<SessionCreateResult> {
    try {
      let session: ISessionScopeHandle;
      if (input.forkFrom !== undefined) {
        const source = await this.resolveTarget(input.forkFrom);
        const meta = await this.sessions.fork({
          sourceSessionId: source.id,
          title: input.title,
        });
        const resumed = await this.instantiation.invokeFunction((accessor) =>
          resumeSessionById(accessor, meta.id),
        );
        if (resumed === undefined) {
          throw new SessionDeliveryError(
            'SESSION_DELIVERY_FAILED',
            `Forked session "${meta.id}" could not be resumed.`,
          );
        }
        session = resumed;
      } else {
        session = await this.sessions.create({
          workDir: input.cwd ?? this.sessionContext.cwd,
          mainAgentBinding: { profile: 'agent' },
        });
        if (input.title !== undefined) {
          await session.accessor.get(ISessionMetadata).setTitle(input.title);
        }
      }
      const sessionId = session.accessor.get(ISessionContext).sessionId;
      if (input.prompt === undefined) return { sessionId, status: 'created' };
      const agent = await mainAgent(session);
      const loop = agent.accessor.get(IAgentLoopService);
      const snapshot = loop.snapshot();
      const { id } = loop.submit({
        message: { role: 'user', content: [{ type: 'text', text: input.prompt }] },
        meta: { origin: { kind: 'user' }, tracked: true },
      });
      if (loop.promptHandle(id) === undefined) {
        throw new SessionDeliveryError(
          'SESSION_DELIVERY_FAILED',
          `Session "${sessionId}" did not accept its first prompt.`,
        );
      }
      return {
        sessionId,
        status: 'created',
        promptId: id,
        promptStatus:
          snapshot.state === 'idle' && !snapshot.paused && snapshot.queue.length === 0
            ? 'started'
            : 'queued',
      };
    } catch (error) {
      return failure(error);
    }
  }

  async list(filter?: string): Promise<readonly SessionListEntry[]> {
    const summaries = await this.listAll();
    const entries = summaries.map((summary) => this.entry(summary));
    const normalized = filter?.trim().toLocaleLowerCase();
    if (normalized === undefined || normalized.length === 0) return entries;
    return entries.filter((entry) =>
      [entry.id, entry.title, entry.cwd, entry.status, entry.dir].some((value) =>
        value.toLocaleLowerCase().includes(normalized),
      ),
    );
  }

  private async resolveTarget(to: string): Promise<SessionSummary> {
    return this.assertActive(await this.resolveTargetSummary(to));
  }

  private async resolveTargetSummary(to: string): Promise<SessionSummary> {
    const id = to.trim();
    const exact = await this.index.get(id);
    if (exact !== undefined) return exact;
    const matches = (await this.listAll()).filter((summary) => summary.title === id);
    if (matches.length === 0) {
      throw new SessionDeliveryError('SESSION_NOT_FOUND', `Session "${id}" does not exist.`);
    }
    if (matches.length > 1) {
      throw new SessionDeliveryError(
        'SESSION_ALIAS_AMBIGUOUS',
        `Session title "${id}" is ambiguous; use one of the candidate session ids.`,
        matches.map((summary) => this.entry(summary)),
      );
    }
    return matches[0]!;
  }

  private assertActive(summary: SessionSummary): SessionSummary {
    if (summary.archived) {
      throw new SessionDeliveryError(
        'SESSION_ARCHIVED',
        `Session "${summary.id}" is archived; restore it explicitly before sending messages.`,
      );
    }
    return summary;
  }

  private async deliver(
    target: SessionSummary,
    message: string,
    origin: SessionMessageOrigin,
    delivery: SessionSendInput['delivery'] = 'queue',
  ): Promise<SessionDeliveryStatus> {
    const session = await this.instantiation.invokeFunction((accessor) =>
      resumeSessionById(accessor, target.id),
    );
    if (session === undefined) {
      throw new SessionDeliveryError('SESSION_NOT_FOUND', `Session "${target.id}" does not exist.`);
    }
    const agent = await mainAgent(session);
    const loop = agent.accessor.get(IAgentLoopService);
    const snapshot = loop.snapshot();
    const status: SessionDeliveryStatus =
      snapshot.state === 'idle' && !snapshot.paused && snapshot.queue.length === 0
        ? 'started'
        : 'queued';
    const { id } = loop.submit(
      {
        message: {
          role: 'user',
          content: [{ type: 'text', text: sessionMessageEnvelope(message, origin) }],
        },
        meta: {
          promptId: origin.messageId,
          origin,
          tracked: true,
        },
      },
      { steerIfActive: delivery === 'steer' },
    );
    const handle = loop.promptHandle(id);
    if (handle === undefined) {
      throw new SessionDeliveryError(
        'SESSION_DELIVERY_FAILED',
        `Session "${target.id}" did not accept message "${origin.messageId}".`,
      );
    }
    return delivery === 'steer' && handle.state === 'steered' ? 'steered' : status;
  }

  private async recordSent(
    toSessionId: string,
    message: string,
    origin: SessionMessageOrigin,
  ): Promise<void> {
    await this.dispatcher.dispatch(
      new SessionMessageSent({
        agentId: this.agentScope.agentId,
        toSessionId,
        message,
        origin,
      }),
    );
  }

  private async findReceivedMessage(messageId: string): Promise<SessionMessageOrigin | undefined> {
    const current = findOrigin(this.context.get(), messageId);
    if (current !== undefined) return current;
    for await (const record of this.wire.readRestorable()) {
      const origin = originFromWireRecord(record, messageId);
      if (origin !== undefined) return origin;
    }
    return undefined;
  }

  private async listAll(): Promise<SessionSummary[]> {
    const result: SessionSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.index.listRecent({
        includeArchived: true,
        before: cursor,
        limit: SESSION_PAGE_SIZE,
      });
      result.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return result;
  }

  private async latestAssistant(target: SessionSummary, limit: number): Promise<string | undefined> {
    const live = this.sessions
      .get(target.id)
      ?.accessor.get(IAgentLifecycleService)
      .handleOf(MAIN_AGENT_ID);
    if (live !== undefined) {
      return latestAssistantText(live.accessor.get(IAgentContextMemoryService).get(), limit);
    }
    const scope = agentScopeOf(
      sessionScopeOf(
        workspacePersistenceScope(this.bootstrap.scope('sessions'), target.workspaceId),
        target.id,
      ),
      MAIN_AGENT_ID,
    );
    const records: WireRecord[] = [];
    for await (const record of this.appendLog.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY, {
      onTruncate: () => {},
    })) {
      records.push(record);
    }
    const folded = foldWireRecords(records, fromPersistentWireRecord);
    const history = folded.replay.flatMap((entry) =>
      entry.type === 'message' ? [entry.message] : [],
    );
    return latestAssistantText(history, limit);
  }

  private entry(summary: SessionSummary): SessionListEntry {
    return {
      id: summary.id,
      title: summary.title ?? summary.id,
      cwd: summary.cwd ?? this.sessions.get(summary.id)?.accessor.get(ISessionContext).cwd ?? '',
      status: this.status(summary),
      dir: sessionDirOf(
        this.bootstrap.homeDir,
        workspacePersistenceScope(this.bootstrap.scope('sessions'), summary.workspaceId),
        summary.id,
      ),
    };
  }

  private status(summary: SessionSummary): SessionListStatus {
    if (summary.archived) return 'archived';
    const agent = this.sessions
      .get(summary.id)
      ?.accessor.get(IAgentLifecycleService)
      .handleOf(MAIN_AGENT_ID);
    if (agent === undefined) return 'idle';
    const snapshot = agent.accessor.get(IAgentLoopService).snapshot();
    if (snapshot.state === 'running') return 'running';
    if (snapshot.queue.length > 0 || snapshot.paused) return 'queued';
    return 'idle';
  }
}

async function mainAgent(session: ISessionScopeHandle): Promise<IAgentScopeHandle> {
  await ensureMainAgent(session);
  const agent = await getOrRestoreAgent(session, MAIN_AGENT_ID);
  if (agent === undefined) {
    throw new SessionDeliveryError(
      ErrorCodes.AGENT_NOT_FOUND,
      `Session "${session.accessor.get(ISessionContext).sessionId}" has no main agent.`,
    );
  }
  return agent;
}

function sessionMessageEnvelope(message: string, origin: SessionMessageOrigin): string {
  const lines = [
    `[message_id: ${origin.messageId}][from: ${origin.fromTitle}(${origin.fromSessionId})]`,
    `[chain_id: ${origin.chainId}][expect_reply: ${String(origin.expectReply)}]`,
  ];
  if (origin.replyTo !== undefined) lines.push(`[reply_to: ${origin.replyTo}]`);
  lines.push(
    `To reply, use session_send with to "${origin.fromSessionId}" and replyTo "${origin.messageId}"; keep this chain instead of starting a new one.`,
    '',
    message,
  );
  return lines.join('\n');
}

function latestAssistantText(history: readonly ContextMessage[], limit: number): string | undefined {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]!;
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
      .trim();
    if (text.length === 0) continue;
    return text.length <= limit ? text : `${sliceOnCodePointBoundary(text, limit)}…`;
  }
  return undefined;
}

function findOrigin(
  history: readonly ContextMessage[],
  messageId: string,
): SessionMessageOrigin | undefined {
  for (const message of history) {
    if (message.id !== messageId || message.origin?.kind !== 'session_message') continue;
    return message.origin;
  }
  return undefined;
}

function originFromWireRecord(
  record: WireRecord,
  messageId: string,
): SessionMessageOrigin | undefined {
  if (record.type !== 'context.append_message') return undefined;
  const message = record['message'] as ContextMessage | undefined;
  return message === undefined ? undefined : findOrigin([message], messageId);
}

function failure(error: unknown): SessionMessageFailure {
  if (error instanceof SessionDeliveryError) {
    return {
      status: 'error',
      error: { code: error.code, message: error.message, candidates: error.candidates },
    };
  }
  if (isError2(error) && error.code === SessionErrors.codes.SESSION_OCCUPIED) {
    return {
      status: 'error',
      error: { code: 'SESSION_OCCUPIED', message: error.message },
    };
  }
  if (isError2(error) && error.code === ErrorCodes.SESSION_NOT_FOUND) {
    return {
      status: 'error',
      error: { code: 'SESSION_NOT_FOUND', message: error.message },
    };
  }
  return {
    status: 'error',
    error: {
      code: 'SESSION_DELIVERY_FAILED',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
