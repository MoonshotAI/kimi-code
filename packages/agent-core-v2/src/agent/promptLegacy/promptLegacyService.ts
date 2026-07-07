/**
 * `promptLegacy` domain — `IAgentPromptLegacyService` implementation.
 *
 * Per-agent v1-compatible scheduler. Owns the active submission and a FIFO
 * queue; gates submissions through `auth`, launches turns through `prompt`,
 * observes active turns through `turn`, applies request overrides through
 * `profile` / `permissionMode`, persists prompt metadata through
 * `sessionMetadata`, publishes updates through `event`, and reads the
 * session identity from `sessionContext`. Legacy `prompt.*` lifecycle events
 * are not emitted (they are not part of the v2 `AgentEvent` union); the HTTP
 * responses carry the same information. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { userCancellationReason } from '#/_base/utils/abort';
import { newMessageId } from '#/agent/contextMemory/messageId';
import { ErrorCodes, KimiError } from '#/errors';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentTurnService, type Turn, type TurnResult } from '#/agent/turn/turn';
import {
  applyPromptMetadataUpdate,
  promptMetadataTextFromContentParts,
} from '#/agent/rpc/prompt-metadata';
import type { ContentPart } from '#/app/llmProtocol/message';
import { IAuthSummaryService } from '#/app/auth/auth';
import { IEventService } from '#/app/event/event';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import type {
  PromptAbortResponse,
  PromptItem,
  PromptListResponse,
  PromptStatus,
  PromptSteerResult,
  PromptSubmission,
  PromptSubmitResult,
} from '@moonshot-ai/protocol';

import { IAgentPromptLegacyService } from './promptLegacy';

interface PromptRecord {
  readonly promptId: string;
  readonly userMessageId: string;
  readonly body: PromptSubmission;
  readonly createdAt: string;
}

interface ActivePrompt extends PromptRecord {
  readonly turn: Turn;
}

export class AgentPromptLegacyService implements IAgentPromptLegacyService {
  declare readonly _serviceBrand: undefined;

  private active: ActivePrompt | undefined;
  private readonly queued: PromptRecord[] = [];
  /** Prompts whose abort was requested; their turn settles asynchronously. */
  private readonly abortedPromptIds = new Set<string>();

  constructor(
    @IAgentPromptService private readonly prompt: IAgentPromptService,
    @IAgentTurnService private readonly turnService: IAgentTurnService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentPermissionModeService private readonly permissionMode: IAgentPermissionModeService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAuthSummaryService private readonly authSummary: IAuthSummaryService,
  ) {}

  list(): PromptListResponse {
    return {
      active: this.active === undefined ? null : toItem(this.active, 'running'),
      queued: this.queued.map((record) => toItem(record, 'queued')),
    };
  }

  async submit(body: PromptSubmission): Promise<PromptSubmitResult> {
    await this.authSummary.ensureReady();
    await this.applyOverrides(body);

    const record = this.createRecord(body);
    if (this.active !== undefined) {
      this.queued.push(record);
      return toItem(record, 'queued');
    }
    const status = await this.launch(record);
    return toItem(record, status);
  }

  async steer(promptIds: readonly string[]): Promise<PromptSteerResult> {
    if (promptIds.length === 0) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, 'prompt_ids must not be empty');
    }
    if (this.active === undefined) {
      throw new KimiError(ErrorCodes.PROMPT_NOT_FOUND, 'no active prompt to steer into');
    }

    const selectedIds = new Set(promptIds);
    const selected: PromptRecord[] = [];
    for (let i = this.queued.length - 1; i >= 0; i--) {
      const record = this.queued[i]!;
      if (selectedIds.has(record.promptId)) {
        selected.push(record);
        this.queued.splice(i, 1);
      }
    }
    if (selected.length !== selectedIds.size) {
      throw new KimiError(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are not queued');
    }
    selected.reverse();

    const content = selected.flatMap((record) => contentToCoreParts(record.body.content));
    await this.prompt.steer({
      role: 'user',
      content,
      toolCalls: [],
      origin: { kind: 'user' },
    }).launched;
    return { steered: true, prompt_ids: [...promptIds] };
  }

  async abort(promptId: string): Promise<PromptAbortResponse> {
    if (this.active?.promptId === promptId) {
      // Mark and cancel; the turn settles asynchronously and `onTurnSettled`
      // clears `active` and starts the next queued prompt.
      this.abortedPromptIds.add(promptId);
      this.active.turn.abortController.abort(userCancellationReason());
      return { aborted: true };
    }

    const index = this.queued.findIndex((item) => item.promptId === promptId);
    if (index >= 0) {
      this.queued.splice(index, 1);
      return { aborted: true };
    }

    throw new KimiError(ErrorCodes.PROMPT_NOT_FOUND, `prompt ${promptId} not found`);
  }

  // --- internals -------------------------------------------------------------

  private createRecord(body: PromptSubmission): PromptRecord {
    // `prompt_id` IS the user-message id: the same `msg_<ulid>` is stamped onto
    // the ContextMessage appended in `launch`, so the prompt and its message
    // share one identity across the wire, the turn, and the snapshot.
    const promptId = newMessageId();
    return {
      promptId,
      userMessageId: promptId,
      body,
      createdAt: new Date().toISOString(),
    };
  }

  private async launch(record: PromptRecord): Promise<PromptStatus> {
    const parts = contentToCoreParts(record.body.content);
    if (parts.length === 0) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, 'prompt content has no supported parts');
    }
    // Mirror v1 (web REST submit -> core.rpc.prompt -> updatePromptMetadata):
    // persist `lastPrompt` and derive an easy title from the first prompt so the
    // web session title is populated as soon as the conversation starts. This is
    // the entry the web actually uses (`POST /api/v1/sessions/{id}/prompts`).
    await applyPromptMetadataUpdate(
      {
        metadata: this.metadata,
        eventService: this.eventService,
        sessionId: this.sessionContext.sessionId,
      },
      promptMetadataTextFromContentParts(parts),
    );
    const turn = await this.prompt.prompt({
      id: record.promptId,
      role: 'user',
      content: parts,
      toolCalls: [],
      origin: { kind: 'user' },
    });
    if (turn === undefined) {
      if (this.turnService.getActiveTurn() !== undefined) {
        // Busy with a turn started outside the legacy service (e.g. via /api/v2);
        // keep the record queued so it runs once the agent is idle.
        this.queued.unshift(record);
        return 'queued';
      }
      return 'blocked';
    }
    this.active = { ...record, turn };
    void turn.result.then((result) => this.onTurnSettled(record.promptId, result));
    return 'running';
  }

  private onTurnSettled(promptId: string, result: TurnResult): void {
    if (this.active?.promptId !== promptId) return;
    this.active = undefined;
    this.abortedPromptIds.delete(promptId);
    void result;
    this.startNextQueued();
  }

  private startNextQueued(): void {
    if (this.active !== undefined) return;
    const next = this.queued.shift();
    if (next === undefined) return;
    void this.launch(next);
  }

  private async applyOverrides(body: PromptSubmission): Promise<void> {
    if (body.model !== undefined) {
      await this.profile.setModel(body.model);
    }
    if (body.thinking !== undefined) {
      this.profile.setThinking(body.thinking);
    }
    if (body.permission_mode !== undefined) {
      this.permissionMode.setMode(body.permission_mode);
    }
  }
}

function toItem(record: PromptRecord, status: PromptStatus): PromptItem {
  return {
    prompt_id: record.promptId,
    user_message_id: record.userMessageId,
    status,
    content: record.body.content,
    created_at: record.createdAt,
  };
}

function contentToCoreParts(content: PromptSubmission['content']): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        parts.push({ type: 'text', text: part.text });
        break;
      case 'image':
        if (part.source.kind === 'url') {
          parts.push({ type: 'image_url', imageUrl: { url: part.source.url } });
        } else if (part.source.kind === 'base64') {
          parts.push({
            type: 'image_url',
            imageUrl: { url: `data:${part.source.media_type};base64,${part.source.data}` },
          });
        }
        break;
      case 'video':
        if (part.source.kind === 'url') {
          parts.push({ type: 'video_url', videoUrl: { url: part.source.url } });
        } else if (part.source.kind === 'base64') {
          parts.push({
            type: 'video_url',
            videoUrl: { url: `data:${part.source.media_type};base64,${part.source.data}` },
          });
        }
        break;
      // tool_use / tool_result / file / thinking are not valid user-prompt input.
    }
  }
  return parts;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPromptLegacyService,
  AgentPromptLegacyService,
  InstantiationType.Delayed,
  'promptLegacy',
);
