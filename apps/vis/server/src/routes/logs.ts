import { Hono } from 'hono';
import { join } from 'node:path';

import { KIMI_CODE_HOME } from '../config';
import { discoverLogFiles, readLogs } from '../lib/log-reader';
import { readSessionDetail } from '../lib/session-store';

const SESSION_LOG_REL = ['logs', 'kimi-code.log'] as const;
const GLOBAL_LOG_REL = ['logs', 'global', 'kimi-code.log'] as const;
const HOME_GLOBAL_LOG_REL = ['logs', 'kimi-code.log'] as const;

export function logsRoute(home: string = KIMI_CODE_HOME): Hono {
  const r = new Hono();
  r.get('/:id/logs', async (c) => {
    const id = c.req.param('id');
    const which = c.req.query('which') === 'global' ? 'global' : 'session';
    const detail = await readSessionDetail(home, id);
    if (!detail) {
      return c.json({ error: 'session not found', code: 'NOT_FOUND' }, 404);
    }
    const sessionLog = join(detail.sessionDir, ...SESSION_LOG_REL);
    // The global diagnostic log is a single shared file. In an exported bundle
    // it is captured under the session dir (logs/global/kimi-code.log); for a
    // live local session it lives at <KIMI_CODE_HOME>/logs/kimi-code.log
    // (agent-core's resolveGlobalLogPath), NOT under the session dir.
    const globalLog = detail.imported
      ? join(detail.sessionDir, ...GLOBAL_LOG_REL)
      : join(home, ...HOME_GLOBAL_LOG_REL);
    // Either log may have rotated (kimi-code.log.1, .2, …); discover the active
    // file plus its archives so a bundle with only rotated logs still surfaces.
    const sessionFiles = await discoverLogFiles(sessionLog);
    const globalFiles = await discoverLogFiles(globalLog);
    const available = {
      session: sessionFiles.length > 0,
      global: globalFiles.length > 0,
    };
    const targetFiles = which === 'global' ? globalFiles : sessionFiles;
    const result = await readLogs(targetFiles);
    return c.json({
      sessionId: id,
      which,
      available,
      lines: result?.lines ?? [],
      truncated: result?.truncated ?? false,
    });
  });
  return r;
}
