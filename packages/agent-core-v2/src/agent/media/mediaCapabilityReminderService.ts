import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { LifecycleScope } from '#/app/scopes';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import type { ContextInjectionContext, ContextInjectionResult } from '#/features/reminder/types';
import { IEventDispatcher } from '#/state/eventDispatcher';

import {
  IAgentMediaCapabilityReminderService,
  type MediaCapabilityDisclosure,
} from './mediaCapabilityReminder';

export const MEDIA_CAPABILITY_REMINDER_VARIANT = 'media_capability';

export class AgentMediaCapabilityReminderService
  extends Disposable
  implements IAgentMediaCapabilityReminderService
{
  declare readonly _serviceBrand: undefined;

  private baseline?: MediaCapabilityDisclosure;

  constructor(
    @IAgentReminderService reminder: IAgentReminderService,
    @IAgentLoopService private readonly profile: IAgentLoopService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IEventDispatcher dispatcher: IEventDispatcher,
  ) {
    super();
    this.captureBaseline();
    this._register(
      dispatcher.hooks.onDidRestore.register('media', async (_ctx, next) => {
        if (this.profile.history().length === 0) {
          this.captureBaseline();
        } else {
          this.baseline = undefined;
        }
        await next();
      }),
    );
    this._register(
      reminder.register<MediaCapabilityDisclosure>(
        MEDIA_CAPABILITY_REMINDER_VARIANT,
        (context) => this.inject(context),
      ),
    );
  }

  private captureBaseline(): void {
    if (!this.profile.hasModel() || this.profile.data().profileName === undefined) return;
    this.baseline = this.currentDisclosure();
  }

  private currentDisclosure(): MediaCapabilityDisclosure {
    const capabilities = this.profile.getModelCapabilities();
    return {
      imageIn: capabilities.image_in,
      videoIn: capabilities.video_in,
    };
  }

  private inject({
    lastDisclosure,
  }: ContextInjectionContext<MediaCapabilityDisclosure>):
    | ContextInjectionResult<MediaCapabilityDisclosure>
    | undefined {
    if (!this.profile.hasModel() || this.profile.data().profileName === undefined) return undefined;
    if (!this.toolPolicy.isToolActive('Read')) return undefined;
    const current = this.currentDisclosure();
    const previous = lastDisclosure ?? this.baseline;
    if (previous === undefined) {
      this.baseline = current;
      const history = this.profile.history();
      const unsupportedPriorMedia =
        (!current.imageIn && hasMediaPartInHistory(history, 'image_url')) ||
        (!current.videoIn && hasMediaPartInHistory(history, 'video_url'));
      if (!unsupportedPriorMedia) return undefined;
      return {
        content: renderMediaCapabilityReminder(current),
        disclosure: current,
      };
    }
    if (previous.imageIn === current.imageIn && previous.videoIn === current.videoIn) {
      return undefined;
    }
    this.baseline = current;
    return {
      content: renderMediaCapabilityReminder(current),
      disclosure: current,
    };
  }
}

function hasMediaPartInHistory(
  history: readonly ContextMessage[],
  partType: 'image_url' | 'video_url',
): boolean {
  return history.some((message) => message.content.some((part) => part.type === partType));
}

function renderMediaCapabilityReminder(disclosure: MediaCapabilityDisclosure): string {
  if (!disclosure.imageIn && !disclosure.videoIn) {
    return (
      'Model media capabilities changed: the current model does not support image or video input. ' +
      'Earlier media in this conversation is omitted, and Read can currently read text files only — ' +
      'do not call Read on image or video files.'
    );
  }
  if (disclosure.imageIn && !disclosure.videoIn) {
    return (
      'Model media capabilities changed: the current model supports image input via Read, ' +
      'but does not support video input (earlier videos are omitted; do not call Read on video files).'
    );
  }
  if (!disclosure.imageIn && disclosure.videoIn) {
    return (
      'Model media capabilities changed: the current model supports video input via Read, ' +
      'but does not support image input (earlier images are omitted; do not call Read on image files).'
    );
  }
  return (
    'Model media capabilities changed: the current model supports both image and video input. ' +
    'You can pass image and video file paths directly to Read.'
  );
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentMediaCapabilityReminderService,
  AgentMediaCapabilityReminderService,
  ScopeActivation.OnScopeCreated,
  'media',
);
