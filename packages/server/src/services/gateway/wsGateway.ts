import { createDecorator, type TelemetryClient } from '@moonshot-ai/agent-core';

import type { AbortHandler, FsWatchHandler, TerminalHandler } from '#/ws/connection';

export const WS_PATH = '/api/v1/ws';

export interface IWSGateway {
  readonly _serviceBrand: undefined;

  readonly size: number;

  setAbortHandler(handler: AbortHandler): void;

  setFsWatchHandler(handler: FsWatchHandler): void;

  setTerminalHandler(handler: TerminalHandler): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IWSGateway = createDecorator<IWSGateway>('wsGateway');

export interface WSGatewayOptions {
  pingIntervalMs?: number;

  pongTimeoutMs?: number;

  /**
   * Optional observer invoked after a client connects or disconnects, with the
   * live connection count. The daemon host uses it to detect the "last client
   * left" transition and start its idle-shutdown grace timer.
   */
  onConnectionCountChange?: (size: number) => void;

  /**
   * Optional telemetry client used to emit `ws_connected` / `ws_disconnected`
   * events. Hosts that already bootstrap telemetry (e.g. the CLI server
   * command) hand in the same client they pass to `coreProcessOptions` so all
   * web-path events share one sink + context.
   */
  telemetry?: TelemetryClient;
}
