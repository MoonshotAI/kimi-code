import { USER_PROMPT_ORIGIN, type ContextMessage } from '#/agent/contextMemory/types';
import { newMessageId } from '#/agent/contextMemory/messageId';
import { StepRequest, type StepRequestOptions, type TurnSeed } from '#/agent/loop/stepRequest';
import { gateImageFormatParts } from '#/agent/media/image-compress';
import type { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';

abstract class UserMessageStepRequest extends StepRequest {
  protected readonly message: ContextMessage;
  private readonly ownerPromptId: string;

  constructor(
    message: ContextMessage,
    private readonly captions: readonly string[],
    private readonly reminders: IAgentSystemReminderService,
    options?: StepRequestOptions,
  ) {
    super(options);
    this.ownerPromptId = message.id ?? newMessageId();
    this.message = {
      ...message,
      id: this.ownerPromptId,
      content: gateImageFormatParts(message.content),
    };
  }

  override get turnSeed(): TurnSeed {
    return { input: this.message.content, origin: this.message.origin ?? USER_PROMPT_ORIGIN };
  }

  override onWillMaterialize(): void {
    for (const caption of this.captions) {
      this.reminders.appendSystemReminder(caption, {
        kind: 'injection',
        variant: 'image_compression',
        ownerPromptId: this.ownerPromptId,
      });
    }
  }

  resolveContextMessages(): readonly ContextMessage[] {
    return this.message.content.length > 0 ? [this.message] : [];
  }
}

export class PromptStepRequest extends UserMessageStepRequest {
  readonly kind = 'prompt';

  constructor(
    message: ContextMessage,
    captions: readonly string[],
    reminders: IAgentSystemReminderService,
  ) {
    super(message, captions, reminders, { admission: 'newTurn' });
  }

  override get turnSeed(): TurnSeed {
    return {
      input: this.message.content,
      origin: this.message.origin ?? USER_PROMPT_ORIGIN,
      promptId: this.message.id,
    };
  }
}

export class SteerStepRequest extends UserMessageStepRequest {
  readonly kind = 'steer';

  constructor(
    message: ContextMessage,
    captions: readonly string[],
    reminders: IAgentSystemReminderService,
    private readonly recordSteer: (message: ContextMessage) => void,
    private readonly forgetSteer: (request: SteerStepRequest) => void,
    admission: 'activeTurnOnly' | 'activeOrNewTurn' = 'activeTurnOnly',
  ) {
    super(message, captions, reminders, {
      mergeable: true,
      turnScoped: false,
      admission,
    });
  }

  override onWillMaterialize(): void {
    this.recordSteer(this.message);
    super.onWillMaterialize();
  }

  protected override onSettled(): void {
    this.forgetSteer(this);
  }
}

export class RetryStepRequest extends StepRequest {
  readonly kind = 'retry';

  constructor() {
    super({ admission: 'newTurn' });
  }

  override get turnSeed(): TurnSeed {
    return { input: [], origin: { kind: 'retry' } };
  }

  resolveContextMessages(): readonly ContextMessage[] {
    return [];
  }
}
