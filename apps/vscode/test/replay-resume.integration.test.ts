/**
 * Scenario: persisted Node SDK sessions are reopened and rendered by the VS Code replay adapter.
 * Responsibilities: restored tool displays and child-agent steps through the public resume state.
 * Wiring: Node SDK, core, storage, and HTTP provider adapter are real; only the remote provider is local.
 * Run: pnpm --filter kimi-code exec vitest run --config vitest.config.ts test/replay-resume.integration.test.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createKimiHarness,
  type Event,
  type KimiHarness,
  type Session,
} from "@moonshot-ai/kimi-code-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  createFakeProviderHarness,
  type FakeProviderHarness,
} from "../../../packages/kosong/test/e2e/fake-provider-harness";
import { replaySessionToWebviewEvents } from "../src/runtime/replay-adapter";

const MODEL_ALIAS = "vscode-replay-test";

interface ReplayRig {
  readonly rootDir: string;
  readonly workDir: string;
  readonly harness: KimiHarness;
  readonly provider: FakeProviderHarness;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function createReplayRig(): Promise<ReplayRig> {
  const rootDir = await mkdtemp(join(tmpdir(), "kimi-vscode-replay-"));
  const homeDir = join(rootDir, "home");
  const workDir = join(rootDir, "workspace");
  await Promise.all([mkdir(homeDir), mkdir(workDir)]);
  const provider = await createFakeProviderHarness();
  const harness = createKimiHarness({
    homeDir,
    identity: { userAgentProduct: "kimi-code-vscode", version: "test" },
  });
  await harness.setConfig({
    providers: {
      local: {
        type: "kimi",
        baseUrl: `${provider.baseUrl}/v1`,
        apiKey: "sk-test",
      },
    },
    models: {
      [MODEL_ALIAS]: {
        provider: "local",
        model: "mock-model",
        maxContextSize: 128_000,
      },
    },
    defaultModel: MODEL_ALIAS,
  });
  cleanups.push(async () => {
    try {
      await harness.close();
    } finally {
      try {
        await provider.close();
      } finally {
        await rm(rootDir, { recursive: true, force: true });
      }
    }
  });
  return { rootDir, workDir, harness, provider };
}

function completionChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id: "chatcmpl-vscode-replay",
    object: "chat.completion.chunk",
    created: 1,
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function runPrompt(session: Session, prompt: string): Promise<void> {
  const ended = waitForEvent(
    session,
    (event) => event.type === "turn.ended" && event.agentId === "main",
  );
  await session.prompt(prompt);
  await ended;
}

function waitForEvent(
  session: Session,
  predicate: (event: Event) => boolean,
): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for session event"));
    }, 5_000);
    const unsubscribe = session.onEvent((event) => {
      if (!predicate(event)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}

describe("VS Code replay from a public Node SDK resume state", () => {
  it("restores persisted file and todo displays", async () => {
    const rig = await createReplayRig();
    const filePath = join(rig.workDir, "sample.txt");
    await writeFile(filePath, "before\n", "utf8");
    let requestCount = 0;
    rig.provider.route("POST", "/v1/chat/completions", async (_request, reply) => {
      requestCount += 1;
      if (requestCount === 1) {
        await reply.sseJson(200, [
          completionChunk({
            tool_calls: [
              {
                index: 0,
                id: "edit-call-1",
                type: "function",
                function: {
                  name: "Edit",
                  arguments: JSON.stringify({
                    path: "sample.txt",
                    old_string: "before",
                    new_string: "after",
                  }),
                },
              },
              {
                index: 1,
                id: "write-call-1",
                type: "function",
                function: {
                  name: "Write",
                  arguments: JSON.stringify({
                    path: "created.txt",
                    content: "created content\n",
                  }),
                },
              },
              {
                index: 2,
                id: "todo-call-1",
                type: "function",
                function: {
                  name: "TodoList",
                  arguments: JSON.stringify({
                    todos: [{ title: "Verify resume", status: "done" }],
                  }),
                },
              },
            ],
          }),
          completionChunk({}, "tool_calls"),
        ]);
        return;
      }
      await reply.sseJson(200, [
        completionChunk({ content: "Changes complete." }),
        completionChunk({}, "stop"),
      ]);
    });
    const session = await rig.harness.createSession({
      id: "ses_vscode_replay_displays",
      workDir: rig.workDir,
      model: MODEL_ALIAS,
    });
    await session.setPermission("yolo");
    await runPrompt(session, "Update the file and checklist");
    await session.close();

    const resumed = await rig.harness.resumeSession({
      id: session.id,
      includeSubagents: true,
    });
    const state = resumed.getResumeState();
    if (state === undefined) throw new Error("Expected public resume state");
    const events = replaySessionToWebviewEvents(state, resumed.id);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ToolResult",
        payload: expect.objectContaining({
          tool_call_id: "write-call-1",
          return_value: expect.objectContaining({
            display: [{
              type: "diff",
              path: join(rig.workDir, "created.txt"),
              old_text: "",
              new_text: "created content\n",
            }],
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ToolResult",
        payload: expect.objectContaining({
          tool_call_id: "edit-call-1",
          return_value: expect.objectContaining({
            display: [{ type: "diff", path: filePath, old_text: "before", new_text: "after" }],
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ToolResult",
        payload: expect.objectContaining({
          tool_call_id: "todo-call-1",
          return_value: expect.objectContaining({
            display: [{
              type: "todo",
              items: [{ title: "Verify resume", status: "done" }],
            }],
          }),
        }),
      }),
    );
  });

  it("restores a child step under its original Agent tool call", async () => {
    const rig = await createReplayRig();
    const childAnswer = `Subagent restored evidence. ${"Detailed persisted finding. ".repeat(10)}`;
    let requestCount = 0;
    rig.provider.route("POST", "/v1/chat/completions", async (_request, reply) => {
      requestCount += 1;
      if (requestCount === 1) {
        await reply.sseJson(200, [
          completionChunk({
            tool_calls: [{
              index: 0,
              id: "agent-call-1",
              type: "function",
              function: {
                name: "Agent",
                arguments: JSON.stringify({
                  prompt: "Inspect the workspace and report one finding.",
                  description: "inspect workspace",
                  subagent_type: "coder",
                  run_in_background: false,
                }),
              },
            }],
          }),
          completionChunk({}, "tool_calls"),
        ]);
        return;
      }
      if (requestCount === 2) {
        await reply.sseJson(200, [
          completionChunk({ content: childAnswer }),
          completionChunk({}, "stop"),
        ]);
        return;
      }
      await reply.sseJson(200, [
        completionChunk({ content: "Parent received the finding." }),
        completionChunk({}, "stop"),
      ]);
    });
    const session = await rig.harness.createSession({
      id: "ses_vscode_replay_subagent",
      workDir: rig.workDir,
      model: MODEL_ALIAS,
    });
    await session.setPermission("yolo");
    await runPrompt(session, "Delegate this inspection");
    await session.close();

    const resumed = await rig.harness.resumeSession({
      id: session.id,
      includeSubagents: true,
    });
    const state = resumed.getResumeState();
    if (state === undefined) throw new Error("Expected public resume state");
    const events = replaySessionToWebviewEvents(state, resumed.id);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "SubagentEvent",
        payload: {
          parent_tool_call_id: "agent-call-1",
          event: { type: "StepBegin", payload: { n: 1 } },
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "SubagentEvent",
        payload: {
          parent_tool_call_id: "agent-call-1",
          event: { type: "ContentPart", payload: { type: "text", text: childAnswer } },
        },
      }),
    );
  });
});
