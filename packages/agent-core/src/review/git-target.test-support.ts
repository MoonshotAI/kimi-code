import { Readable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';

export function createReviewGitTestProcess(stdout: string, exitCode = 0): KaosProcess {
  return {
    stdin: { write: () => true, end: () => {} } as never,
    stdout: Readable.from([stdout]),
    stderr: Readable.from(['']),
    pid: 1,
    exitCode,
    wait: async () => exitCode,
    kill: async () => {},
  };
}
