/**
 * `createKlient` over a unix domain socket, plus the matching host
 * (`serveKlientIpc`) for processes embedding the engine. Node-only.
 */

import { createKlientFromChannel, type Klient, type KlientOptions } from '../../core/klient.js';
import { IpcChannel, type IpcChannelOptions } from './channel.js';

export {
  serveKlientIpc,
  type KlientIpcHost,
  type ServeKlientIpcOptions,
} from './host.js';

export interface IpcKlientOptions extends KlientOptions, IpcChannelOptions {}

export function createKlient(options: IpcKlientOptions): Klient {
  return createKlientFromChannel(new IpcChannel(options), options);
}
