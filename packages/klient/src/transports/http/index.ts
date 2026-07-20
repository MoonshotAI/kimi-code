/**
 * `createKlient` over HTTP(S) against kap-server's `/api/v2` surface. Event
 * subscriptions transparently ride a lazily opened WebSocket — after
 * initialization the klient behaves exactly like its ipc/memory siblings.
 * Browser-safe: only `fetch` + an injectable `WebSocket` are required.
 */

import { createKlientFromChannel, type Klient, type KlientOptions } from '../../core/klient.js';
import { HttpChannel, type HttpChannelOptions } from './channel.js';

export interface HttpKlientOptions extends KlientOptions, HttpChannelOptions {}

export function createKlient(options: HttpKlientOptions): Klient {
  return createKlientFromChannel(new HttpChannel(options), options);
}
