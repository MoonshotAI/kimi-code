/**
 * Scenario: the extension host boots the shared client telemetry pipeline.
 * Responsibilities: resolve home/device id, tag every event with the vscode
 * ui_mode/app name, honor the config toggle, and shut down cleanly.
 * Run: pnpm --filter kimi-code exec vitest run --config vitest.config.ts test/telemetry.test.ts
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  flushTelemetrySync,
  getDefaultTelemetryClient,
  resetDefaultTelemetryClientForTests,
} from "@moonshot-ai/kimi-telemetry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initializeVscodeTelemetry } from "../src/runtime/telemetry";

let homeDir: string;

beforeEach(async () => {
  resetDefaultTelemetryClientForTests();
  homeDir = await mkdtemp(join(tmpdir(), "kimi-vscode-telemetry-"));
});

afterEach(async () => {
  resetDefaultTelemetryClientForTests();
  await rm(homeDir, { recursive: true, force: true });
});

describe("initializeVscodeTelemetry", () => {
  it("attaches the shared pipeline with vscode context", async () => {
    const telemetry = initializeVscodeTelemetry({ homeDir, version: "0.7.5" });

    expect(telemetry.homeDir).toBe(homeDir);
    expect(getDefaultTelemetryClient().getSink()).not.toBeNull();

    telemetry.client.track("test_event", { foo: "bar" });
    flushTelemetrySync();

    const saved = await readSavedEvents(homeDir);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      event: "test_event",
      properties: { foo: "bar" },
      context: {
        app_name: "kimi-code-vscode",
        ui_mode: "vscode",
        version: "0.7.5",
      },
    });
  });

  it("reports nothing when the config disables telemetry", async () => {
    await writeConfig(homeDir, "telemetry = false\n");

    const telemetry = initializeVscodeTelemetry({ homeDir, version: "0.7.5" });

    expect(telemetry.homeDir).toBe(homeDir);
    expect(getDefaultTelemetryClient().getSink()).toBeNull();
    telemetry.client.track("dropped_event");
    flushTelemetrySync();
    await expect(readdir(join(homeDir, "telemetry"))).rejects.toThrow();
  });
});

async function writeConfig(dir: string, text: string): Promise<void> {
  await writeFile(join(dir, "config.toml"), text, "utf-8");
}

interface SavedEvent {
  readonly event: string;
  readonly properties: Record<string, unknown>;
  readonly context: Record<string, unknown>;
}

async function readSavedEvents(dir: string): Promise<SavedEvent[]> {
  const files = await readdir(join(dir, "telemetry"));
  const events: SavedEvent[] = [];
  for (const file of files) {
    const text = await readFile(join(dir, "telemetry", file), "utf-8");
    for (const line of text.split("\n")) {
      if (line.length > 0) events.push(JSON.parse(line) as SavedEvent);
    }
  }
  return events;
}
