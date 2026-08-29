/**
 * Scenario: the engine rollback switch is the single engine-selection decision.
 * Responsibilities: default to the v2 engine, honor the setting, let a truthy
 * KIMI_CODE_LEGACY_FLAG override the setting, and ignore non-truthy env values.
 * Wiring: the real VSCodeSettings module; the vscode configuration store is a
 * mutable in-memory fake.
 * Run: pnpm --filter kimi-code exec vitest run test/vscode-settings.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configStore = vi.hoisted(() => ({ values: new Map<string, unknown>() }));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => configStore.values.get(key) ?? fallback,
    }),
  },
}));

import {
  LEGACY_ENGINE_ENV,
  resolveUseAgentCoreV1,
  VSCodeSettings,
} from "../src/config/vscode-settings";

beforeEach(() => {
  // A developer shell may export the flag; the cases set it explicitly.
  vi.stubEnv(LEGACY_ENGINE_ENV, "");
});

afterEach(() => {
  configStore.values.clear();
  vi.unstubAllEnvs();
});

describe("resolveUseAgentCoreV1", () => {
  it("defaults to the v2 engine", () => {
    expect(resolveUseAgentCoreV1(false, {})).toBe(false);
  });

  it("honors the setting when the env var is absent", () => {
    expect(resolveUseAgentCoreV1(true, {})).toBe(true);
  });

  it("lets a truthy env var override a false setting", () => {
    for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
      expect(resolveUseAgentCoreV1(false, { [LEGACY_ENGINE_ENV]: value })).toBe(true);
    }
  });

  it("ignores non-truthy env values and falls back to the setting", () => {
    for (const value of ["", "0", "false", "off", "anything"]) {
      expect(resolveUseAgentCoreV1(true, { [LEGACY_ENGINE_ENV]: value })).toBe(true);
      expect(resolveUseAgentCoreV1(false, { [LEGACY_ENGINE_ENV]: value })).toBe(false);
    }
  });
});

describe("VSCodeSettings.useAgentCoreV1", () => {
  it("reads the kimi.useAgentCoreV1 setting", () => {
    expect(VSCodeSettings.useAgentCoreV1).toBe(false);
    configStore.values.set("useAgentCoreV1", true);
    expect(VSCodeSettings.useAgentCoreV1).toBe(true);
  });

  it("lets the env var override the setting", () => {
    vi.stubEnv(LEGACY_ENGINE_ENV, "1");
    expect(VSCodeSettings.useAgentCoreV1).toBe(true);
  });
});
