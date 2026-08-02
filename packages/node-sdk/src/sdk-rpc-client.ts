/**
 * SDK harness assembly — the Rust engine is the only engine.
 *
 * `createKimiHarness` wires the SDK harness to `RustRpcClient`, which talks
 * to the Rust agent engine (`@moonshot-ai/kimi-agent/rust-loop`) directly.
 * The KimiCore-backed `SDKRpcClient` is gone with the TS engine.
 *
 * NOTE (packaging): `@moonshot-ai/kimi-agent` is a private workspace package;
 * publishing `@moonshot-ai/kimi-code-sdk` requires the rust-loop bridge to be
 * published or vendored — tracked as a release-planning follow-up.
 */
import * as rustLoop from '@moonshot-ai/kimi-agent/rust-loop';

import { KimiAuthFacade } from '#/auth';
import { KimiHarness } from '#/kimi-harness';
import type { KimiHarnessOptions } from '#/types';
import { resolveConfigPath, resolveKimiHome } from '#/legacy/config';

import { RustRpcClient, type RustLoopApi } from './rust/rpc-client';

export function createKimiHarness(options: KimiHarnessOptions): KimiHarness {
  const homeDir = resolveKimiHome(options.homeDir);
  const configPath = resolveConfigPath({
    homeDir,
    configPath: options.configPath,
  });
  // Config is host data: the SDK owns config.toml under its home dir (the
  // engine's config path is engine-internal). The SDK's config API reads and
  // writes it locally (see RustRpcClient.getKimiConfig/setKimiConfig).
  const rpc = new RustRpcClient({
    rustLoop: rustLoop as unknown as RustLoopApi,
    homeDir,
    configPath,
    identity: options.identity,
    telemetry: options.telemetry,
    llmStep: options.llmStep,
  });
  const auth = new KimiAuthFacade({
    homeDir,
    configPath,
    identity: options.identity,
    onRefresh: options.onOAuthRefresh,
  });
  return new KimiHarness(rpc, {
    identity: rpc.identity,
    uiMode: options.uiMode,
    homeDir: rpc.homeDir,
    configPath: rpc.configPath,
    auth,
    telemetry: rpc.telemetry,
    ensureConfigFile: () => rpc.ensureConfigFile(),
    onClose: () => rpc.close(),
    // The Rust engine owns image handling; no client-side ingestion limits.
    imageLimits: undefined,
    sessionStartedProperties: options.sessionStartedProperties,
  });
}
