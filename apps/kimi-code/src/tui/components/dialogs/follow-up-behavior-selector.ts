import { FollowUpBehaviorSchema, type FollowUpBehavior } from '../../config';
import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

function followUpBehaviorOptions(ctrlEnterRecognized: boolean): readonly (ChoiceOption & { readonly value: FollowUpBehavior })[] {
  return [
    {
      value: 'queue',
      label: 'Queue',
      description: `Enter queues follow-ups until Kimi finishes.${ctrlEnterRecognized ? ' Ctrl-Enter steers one.' : ''}`,
    },
    {
      value: 'steer',
      label: 'Steer',
      description: `Enter steers follow-ups into the current turn. ${ctrlEnterRecognized ? 'Ctrl-Enter' : 'Ctrl-Q'} queues one.`,
    },
  ];
}

export interface FollowUpBehaviorSelectorOptions {
  readonly currentValue: FollowUpBehavior;
  readonly ctrlEnterRecognized: boolean;
  readonly onSelect: (value: FollowUpBehavior) => void;
  readonly onCancel: () => void;
}

export class FollowUpBehaviorSelectorComponent extends ChoicePickerComponent {
  constructor(opts: FollowUpBehaviorSelectorOptions) {
    super({
      title: 'Follow-up behavior',
      options: followUpBehaviorOptions(opts.ctrlEnterRecognized),
      currentValue: opts.currentValue,
      onSelect: (value) => {
        const parsed = FollowUpBehaviorSchema.safeParse(value);
        if (parsed.success) opts.onSelect(parsed.data);
      },
      onCancel: opts.onCancel,
    });
  }
}
