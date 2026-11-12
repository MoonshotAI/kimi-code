import { FollowUpBehaviorSchema, type FollowUpBehavior } from '../../config';
import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

const FOLLOW_UP_BEHAVIOR_OPTIONS = [
  {
    value: 'queue',
    label: 'Queue',
    description: 'While Kimi is working, Enter queues the message and Ctrl-Enter / Cmd-Enter steers it into the current turn.',
  },
  {
    value: 'steer',
    label: 'Steer',
    description: 'While Kimi is working, Enter steers the message into the current turn and Ctrl-Enter / Cmd-Enter or Ctrl-Q queues it.',
  },
] as const satisfies readonly (ChoiceOption & { readonly value: FollowUpBehavior })[];

export interface FollowUpBehaviorSelectorOptions {
  readonly currentValue: FollowUpBehavior;
  readonly onSelect: (value: FollowUpBehavior) => void;
  readonly onCancel: () => void;
}

export class FollowUpBehaviorSelectorComponent extends ChoicePickerComponent {
  constructor(opts: FollowUpBehaviorSelectorOptions) {
    super({
      title: 'Follow-up behavior',
      options: FOLLOW_UP_BEHAVIOR_OPTIONS,
      currentValue: opts.currentValue,
      onSelect: (value) => {
        const parsed = FollowUpBehaviorSchema.safeParse(value);
        if (parsed.success) opts.onSelect(parsed.data);
      },
      onCancel: opts.onCancel,
    });
  }
}
