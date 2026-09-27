import {
  createFeature,
  createHistoryMessageBuilder,
  extractText,
  useAgent,
  useAgentStore,
  useBeforeStep,
  type FeatureSpec,
  type HistoryMessage,
} from '@moonshot-ai/agent-core';

export const DATE_CHANGE_REMIND_KEY = 'date-change';

export interface CreateDateChangeProps {
  readonly now?: () => Date;
  readonly timeZone?: string;
}

export function initialDateReminder(localDate: string): string {
  return `Today's date is ${localDate}. The current date is restated in a reminder whenever it changes; rely on the latest such reminder for the current date. DO NOT mention this to the user explicitly.`;
}

export function dateChangeReminder(localDate: string): string {
  return `The date has changed. Today's date is now ${localDate}. Rely on this reminder over any earlier date statement for the current date. DO NOT mention this to the user explicitly.`;
}

export function createDateChange(props: CreateDateChangeProps = {}): FeatureSpec {
  const now = props.now ?? (() => new Date());
  const timeZone = props.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return createFeature('dateChange', {
    agent() {
      const agent = useAgent();
      const store = useAgentStore();
      let disclosed = lastDisclosedDate(store.getState().history);
      useBeforeStep(() => {
        const current = localDateOf(now(), timeZone);
        if (current === disclosed) return;
        const text = disclosed === undefined ? initialDateReminder(current) : dateChangeReminder(current);
        disclosed = current;
        void agent
          .remind(
            DATE_CHANGE_REMIND_KEY,
            createHistoryMessageBuilder().systemReminder(text).userMessage(),
          )
          .catch(() => {});
      });
    },
  });
}

function localDateOf(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function lastDisclosedDate(history: readonly HistoryMessage[]): string | undefined {
  const entry = history.findLast(
    (candidate) =>
      candidate.meta?.source === 'reminder' && candidate.meta?.key === DATE_CHANGE_REMIND_KEY,
  );
  if (entry === undefined) return undefined;
  return /(\d{4}-\d{2}-\d{2})/.exec(extractText(entry.message))?.[1];
}
