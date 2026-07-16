/**
 * Scenario: the extension treats any usable credential as "signed in".
 * Responsibilities: OAuth tokens and statically provisioned provider api keys
 * both count; empty configs do not.
 * Run: pnpm exec vitest run --config apps/vscode/vitest.config.ts test/login-context.test.ts
 */

import type { KimiConfig } from "@moonshot-ai/kimi-code-sdk";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  commands: { executeCommand: vi.fn() },
}));

import { hasConfiguredProviderCredentials } from "../src/utils/context";

describe("login context (extension login status)", () => {
  it("reports no credentials for an empty provider config", () => {
    expect(hasConfiguredProviderCredentials({} as KimiConfig)).toBe(false);
    expect(hasConfiguredProviderCredentials({ providers: {} } as KimiConfig)).toBe(false);
  });

  it("ignores providers without an api key", () => {
    const config = {
      providers: {
        "kimi-code": { type: "kimi", baseUrl: "https://api.example.test/v1" },
      },
    } as unknown as KimiConfig;

    expect(hasConfiguredProviderCredentials(config)).toBe(false);
  });

  it("treats a statically provisioned api key as signed in", () => {
    const config = {
      providers: {
        "kimi-code": {
          type: "kimi",
          baseUrl: "https://api.example.test/v1",
          apiKey: "sk-kimi-example",
        },
      },
    } as unknown as KimiConfig;

    expect(hasConfiguredProviderCredentials(config)).toBe(true);
  });

  it("rejects whitespace-only api keys", () => {
    const config = {
      providers: {
        custom: { type: "kimi", apiKey: "   " },
      },
    } as unknown as KimiConfig;

    expect(hasConfiguredProviderCredentials(config)).toBe(false);
  });
});
