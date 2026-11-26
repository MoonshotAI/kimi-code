import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  createKimiHarness,
  type Event,
  type KimiHarness,
  type Session,
} from "@moonshot-ai/kimi-code-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  call,
  reply,
  say,
  startFakeModel,
  type FakeModel,
  type Lane,
} from "@moonshot-ai/testkit/model";
import { replaySessionToWebviewEvents } from "../src/runtime/replay-adapter";

const MODEL_ALIAS = "vscode-replay-test";

interface ReplayRig {
  readonly rootDir: string;
  readonly workDir: string;
  readonly harness: KimiHarness;
  readonly provider: FakeModel;
  readonly replies: Lane;
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
  const provider = await startFakeModel();
  const replies = provider.route("replay", () => true);
  const harness = createKimiHarness({
    homeDir,
    identity: { productName: "kimi-code-vscode", version: "test", platform: "kimi_code_vscode" },
  });
  await harness.setConfig({
    providers: {
      local: {
        type: "kimi",
        baseUrl: provider.baseUrl,
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
        provider.verify();
      } finally {
        try {
          await provider.close();
        } finally {
          await removeTempDir(rootDir);
        }
      }
    }
  });
  return { rootDir, workDir, harness, provider, replies };
}

async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EBUSY" && code !== "EPERM") {
        throw error;
      }
      await delay(10);
    }
  }

  await rm(dir, { recursive: true, force: true });
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
    rig.replies.script(
      reply(
        call(
          "Edit",
          { path: "sample.txt", old_string: "before", new_string: "after" },
          { id: "edit-call-1" },
        ),
        call("Write", { path: "created.txt", content: "created content\n" }, { id: "write-call-1" }),
        call(
          "TodoList",
          { todos: [{ title: "Verify resume", status: "done" }] },
          { id: "todo-call-1" },
        ),
      ),
      say("Changes complete."),
    );
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
    rig.replies.script(
      call(
        "Agent",
        {
          prompt: "Inspect the workspace and report one finding.",
          description: "inspect workspace",
          subagent_type: "coder",
          run_in_background: false,
        },
        { id: "agent-call-1" },
      ),
      say(childAnswer),
      say("Parent received the finding."),
    );
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
