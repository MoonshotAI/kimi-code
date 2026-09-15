import {
  ISessionIndexMirror,
  type SessionSummary,
} from '#/app/sessionIndex/sessionIndex';

export function stubSessionIndexMirror(): ISessionIndexMirror & {
  readonly recorded: SessionSummary[];
} {
  const recorded: SessionSummary[] = [];
  return {
    _serviceBrand: undefined,
    recorded,
    record: (summary) => {
      recorded.push(summary);
    },
    pending: () => recorded,
    evict: async () => {},
    drain: async () => {},
  };
}
