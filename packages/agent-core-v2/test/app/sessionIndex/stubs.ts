/**
 * `sessionIndex` test stubs — capturing no-op `ISessionIndexMirror` for unit
 * tests.
 *
 * Lives under `test/` (not `src/`). Import from a relative path.
 */

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
    drain: async () => {},
  };
}
