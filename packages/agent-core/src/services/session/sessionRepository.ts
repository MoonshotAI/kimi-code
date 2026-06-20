import { join } from 'pathe';
import type { Kaos } from '@moonshot-ai/kaos';

import type { SessionMeta } from '../../session';
import type { ISessionRepository } from './session';

/**
 * Per-session persistence of `state.json` behind the service layer.
 *
 * One `SessionRepository` is bound to exactly one session `homedir`; it is the
 * single writer of that session's `state.json`. Writes are serialized through a
 * chained promise so concurrent `write()` calls are ordered and none are lost
 * or reordered — mirroring the runtime `Session.writeMetadata` semantics this
 * class replaces.
 *
 * This is the `repository` role from `services/AGENTS.md` (M0.5): a
 * persistence-layer contract, not a top-level `*Service`. It is instantiated
 * per session by its owner and is never registered as a singleton.
 */
export class SessionRepository implements ISessionRepository {
  private readonly homedir: string;
  private readonly kaos: Kaos;
  private readonly metadataPath: string;
  private writePromise: Promise<void> = Promise.resolve();

  constructor(homedir: string, kaos: Kaos) {
    this.homedir = homedir;
    this.kaos = kaos;
    this.metadataPath = join(homedir, 'state.json');
  }

  async read(): Promise<SessionMeta> {
    const text = await this.kaos.readText(this.metadataPath);
    return JSON.parse(text) as SessionMeta;
  }

  write(meta: SessionMeta): Promise<void> {
    // Capture the serialized text synchronously, exactly like the previous
    // `Session.writeMetadata`, so the written snapshot matches the metadata at
    // the moment `write` is called even if the caller mutates `meta` afterward.
    const text = JSON.stringify(meta, null, 2);
    const write = async () => {
      await this.kaos.mkdir(this.homedir, { parents: true, existOk: true });
      await this.kaos.writeText(this.metadataPath, text);
    };
    // Chain on both fulfillment and rejection so a failed write does not break
    // the serialization of subsequent writes.
    this.writePromise = this.writePromise.then(write, write);
    return this.writePromise;
  }

  async flush(): Promise<void> {
    await this.writePromise;
  }
}
