/**
 * `FastifyRestGateway` — implementation of `IRestGateway`.
 */

import { Disposable } from '@moonshot-ai/agent-core';

import { IRestGateway, type FastifyLike } from './restGateway';

export class FastifyRestGateway extends Disposable implements IRestGateway {
  readonly _serviceBrand: undefined;

  constructor(public readonly app: FastifyLike) {
    super();
  }

  async listen(host: string, port: number): Promise<string> {
    return this.app.listen({ host, port });
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    // Fire-and-forget — Fastify's close is async but the DI dispose contract is sync.
    // The server's RunningServer.close() awaits `app.close()` explicitly before
    // calling ix.dispose(), so by the time we get here the listener is already
    // stopped; this is a defensive belt-and-suspenders for non-CLI consumers.
    void this.app.close();
    super.dispose();
  }
}
