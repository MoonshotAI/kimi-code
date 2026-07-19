/**
 * `mcp` domain (L5) — `IMcpConfigWatchService` implementation.
 *
 * Watches the user-level mcp.json through the `storage` byte layer
 * (`watch('', 'mcp.json')` — the same exact-key, debounced shape as the config
 * watch, which filters out lock/tmp siblings in the same directory), then
 * JSON-parse-probes the new content before emitting: unparseable content (a
 * half-finished direct edit that slipped past the atomic-write and exact-key
 * filters) logs a warning through `log` and suppresses the event; a missing
 * or blank file counts as valid (the loader treats it as an empty config).
 * Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Emitter, Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { IMcpConfigWatchService } from './mcpConfigWatch';

const MCP_CONFIG_SCOPE = '';
const MCP_CONFIG_KEY = 'mcp.json';

const textDecoder = new TextDecoder();

export class McpConfigWatchService extends Disposable implements IMcpConfigWatchService {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidChange = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this._onDidChange.event;

  constructor(
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    const change = this.storage.watch?.(MCP_CONFIG_SCOPE, MCP_CONFIG_KEY) ?? Event.None;
    this._register(change(() => void this.probe()));
  }

  private async probe(): Promise<void> {
    let text = '';
    try {
      const bytes = await this.storage.read(MCP_CONFIG_SCOPE, MCP_CONFIG_KEY);
      text = bytes === undefined ? '' : textDecoder.decode(bytes);
    } catch (error) {
      this.log.warn('mcp.json change probe failed to read the file', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (text.trim().length > 0) {
      try {
        JSON.parse(text);
      } catch (error) {
        this.log.warn('ignoring mcp.json change: invalid JSON', {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    this._onDidChange.fire();
  }
}

registerScopedService(
  LifecycleScope.App,
  IMcpConfigWatchService,
  McpConfigWatchService,
  InstantiationType.Eager,
  'mcp',
);
