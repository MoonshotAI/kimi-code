import type { Entry, Event, Journal } from './store';

export type CodecResult<T> = T | Promise<T>;

export interface EventCodec<E extends Event, P extends Event, Context = unknown> {
  encode(event: E, context: Context): CodecResult<P>;
  decode(record: P, context: Context): CodecResult<E>;
}

export class JournalDecodeError<C> extends Error {
  constructor(readonly cursor: C, cause: unknown) {
    super('Journal read decode failed.', { cause });
  }
}

export function mapJournal<Logical extends Event, Physical extends Event, C, Context = undefined>(
  journal: Journal<Physical, C>,
  codec: EventCodec<Logical, Physical, Context>,
  context?: Context,
): Journal<Logical, C> {
  const codecContext = context as Context;
  return {
    read: async () => {
      const entries = await journal.read();
      return Promise.all(entries.map(async (entry): Promise<Entry<Logical, C>> => {
        try {
          return { event: await codec.decode(entry.event, codecContext), cursor: entry.cursor };
        } catch (error) {
          throw new JournalDecodeError(entry.cursor, error);
        }
      }));
    },
    append: async (event) => {
      const physical = await codec.encode(event, codecContext);
      const entry = await journal.append(physical);
      return { event, cursor: entry.cursor };
    },
    close: () => journal.close(),
  };
}
