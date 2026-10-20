import {
  createFeature,
  useStepStarting,
  type Feature,
} from '@moonshot-ai/agent-core/app/index';
import {
  createHistoryMessageBuilder,
  createUserEntry,
  type HistoryMessage,
} from '@moonshot-ai/agent-core/history/index';
import { extractText } from '@moonshot-ai/agent-core/llm/message';

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

export function createDateChange(props: CreateDateChangeProps = {}): Feature<void> {
  const now = props.now ?? (() => new Date());
  const timeZone = props.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return createFeature('dateChange', {
    agent() {
      useStepStarting(({ messages }) => {
        const disclosed = lastDisclosedDate(messages);
        const current = localDateOf(now(), timeZone);
        if (current === disclosed) return undefined;
        const text =
          disclosed === undefined ? initialDateReminder(current) : dateChangeReminder(current);
        return {
          messages: [
            ...messages,
            createUserEntry(createHistoryMessageBuilder().systemReminder(text).userMessage(), {
              source: 'reminder',
              key: DATE_CHANGE_REMIND_KEY,
            }),
          ],
        };
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
