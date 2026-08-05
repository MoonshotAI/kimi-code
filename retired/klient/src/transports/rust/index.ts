/**
 * `createKlientFromRust` — the rust transport entry point.
 *
 * Builds a `KlientChannel` over the Rust engine (rust-loop stdio bridge) and
 * hands it to the transport-agnostic klient factory. Host-side services
 * (config / flags / auth / fs / workspaces / plugins / catalog) are
 * assembled here from node-sdk's exported host layer +
 * `@moonshot-ai/kimi-code-oauth`; engine-backed services resolve directly to
 * rust-loop RPCs. This replaces the retired agent-core-v2 dispatcher as the
 * engine binding, letting agent-core-v2 retire.
 */

import * as rustLoop from '@moonshot-ai/kimi-agent/rust-loop';

import { createKlientFromChannel, type Klient, type KlientOptions } from '../../core/klient.js';
import { RustChannel } from './channel.js';
import { buildHostServices as assembleHostServices } from './host/index.js';
import type { RustHostServices } from './types.js';

// ── Service registrations (each group module self-registers) ──────────────
import './services/registry.js';

export interface RustKlientOptions extends KlientOptions {
  /** Engine home dir (defaults to `resolveKimiHome` semantics). */
  readonly homeDir?: string;
  /** Config file path (defaults to `<homeDir>/config.toml`). */
  readonly configPath?: string;
}

/** Assemble the host-side service bag from the group host builders. */
function buildHostServices(options: RustKlientOptions): RustHostServices {
  const homeDir = options.homeDir ?? resolveHomeDir();
  return assembleHostServices({
    homeDir,
    configPath: options.configPath ?? joinPath(homeDir, 'config.toml'),
  });
}

function resolveHomeDir(): string {
  return process.env['KIMI_CODE_HOME'] ?? process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
}

function joinPath(dir: string, file: string): string {
  return `${dir.replace(/[\\/]+$/, '')}/${file}`;
}

export function createKlientFromRust(options: RustKlientOptions = {}): Klient {
  const host = buildHostServices(options);
  const channel = new RustChannel({ rust: rustLoop as unknown as typeof rustLoop, host });
  return createKlientFromChannel(channel, options);
}

export { RustChannel } from './channel.js';
export type { RustCallContext, RustHostServices, RustServiceRegistry } from './types.js';
export { registerService } from './router.js';
