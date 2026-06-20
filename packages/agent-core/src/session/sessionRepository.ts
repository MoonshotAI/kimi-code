import { join } from 'pathe';
import type { Kaos } from '@moonshot-ai/kaos';

import type { SessionMeta } from './index';

/**
 * Single-entity persistence contract for one session's `state.json`.
 *
 * Per `services/AGENTS.md` (M0.5, amended in M1.1 fixup-1) a repository is
 * the aggregate's source of truth: it owns create / get / update and the
 * archive / restore / delete atomic operations, sits *below* the application
 * service layer, and is NOT registered as a top-level `*Service` singleton.
 *
 * Because the runtime `Session` consumes this contract directly, it lives in
 * the runtime layer (`src/session/`) rather than under `services/` — the
 * runtime must not import from `services/` (the dependency-direction fence).
 *
 * `ISessionRepository` is therefore a **per-session** object: one instance is
 * bound to exactly one session `homedir` (its `state.json`), not to the
 * aggregate as a whole. The owner (the runtime `Session`) holds the instance
 * and drives it; cross-session orchestration stays in `ISessionService`.
 *
 * Scope of M1.1: only the read / write / flush operations that already exist
 * on the runtime `Session` are modeled here, because they are the only ones
 * with a byte-for-byte mirrorable persistence implementation today. The
 * archive / restore / purge atomic operations are intentionally deferred to
 * M1.5: `archive`'s file IO currently lives in
 * `src/session/store/session-store.ts`, and `restore` / `purge` have no
 * existing implementation to mirror without inventing new semantics.
 */
export interface ISessionRepository {
  /** Read and parse the session's `state.json`. Throws if it does not exist. */
  read(): Promise<SessionMeta>;

  /**
   * Serialize `meta` to `state.json`. Concurrent calls are ordered: each write
   * is chained onto the previous one so no write is lost or reordered.
   */
  write(meta: SessionMeta): Promise<void>;

  /** Resolve once every previously-submitted `write` has completed. */
  flush(): Promise<void>;
}

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
 * per session by its owner (the runtime `Session`) and is never registered as
 * a singleton.
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
