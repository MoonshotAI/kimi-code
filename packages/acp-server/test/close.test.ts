import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureMainAgent,
  getLiveSessionById,
  HostFileSystem,
  HostProcessService,
  IAgentEnvironmentBindingService,
  IAgentEnvironmentService,
  IAgentLifecycleService,
  IAgentToolRegistryService,
  IEnvironmentService,
  ISessionManager,
} from "@moonshot-ai/agent-core-v2";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeEnvironment } from "../../agent-core-v2/test/environment/stubs";

import { createTestClient, type TestClient } from "./_helpers/acpClient";

describe("acp-server session/close", () => {
  let homeDir: string | undefined;
  let client: TestClient | undefined;

  afterEach(async () => {
    if (client !== undefined) {
      await client.close();
      client = undefined;
    }
    if (homeDir !== undefined) {
      await rm(homeDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
      homeDir = undefined;
    }
  });

  async function boot(): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), "acp-close-"));
    client = await createTestClient({ homeDir });
    await client.send("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    return client;
  }

  it("advertises the close capability and closes a live session", async () => {
    const c = await boot();
    const init = (await c.send("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    })) as {
      agentCapabilities?: { sessionCapabilities?: { close?: unknown } };
    };
    expect(init.agentCapabilities?.sessionCapabilities?.close).toBeDefined();

    const created = (await c.send("session/new", {
      cwd: homeDir,
      mcpServers: [],
    })) as {
      sessionId: string;
    };
    await c.send("session/close", { sessionId: created.sessionId });

    await expect(
      c.send("session/prompt", { sessionId: created.sessionId, prompt: [] }),
    ).rejects.toThrow();
    await c.close();
    await expect(c.close()).resolves.toBeUndefined();
  }, 30_000);

  it("closing an unknown sessionId is a best-effort no-op", async () => {
    const c = await boot();
    await expect(
      c.send("session/close", { sessionId: "does-not-exist" }),
    ).resolves.toEqual({});
  }, 30_000);

  async function mainBinding(sessionId: string) {
    const session = getLiveSessionById(
      client!.server.core.accessor,
      sessionId,
    )!;
    const main = await ensureMainAgent(session);
    const agent = session.accessor
      .get(IAgentLifecycleService)
      .handleOf(main.agentId)!;
    return agent.accessor.get(IAgentEnvironmentBindingService);
  }

  it("keeps local tools after repeated load/close and a terminal-style resume", async () => {
    const c = await boot();
    const created = (await c.send("session/new", {
      cwd: homeDir,
      mcpServers: [],
    })) as { sessionId: string };
    for (let i = 0; i < 2; i++) {
      await c.send("session/load", {
        sessionId: created.sessionId,
        cwd: homeDir,
        mcpServers: [],
      });
    }
    expect((await mainBinding(created.sessionId)).current.environmentId).toBe(
      "local",
    );
    await c.send("session/close", { sessionId: created.sessionId });

    expect(await c.server.klient.session(created.sessionId).restore()).toBe(
      true,
    );
    expect((await mainBinding(created.sessionId)).current.environmentId).toBe(
      "local",
    );
    const session = getLiveSessionById(
      c.server.core.accessor,
      created.sessionId,
    )!;
    const main = await ensureMainAgent(session);
    const agent = session.accessor
      .get(IAgentLifecycleService)
      .handleOf(main.agentId)!;
    const tool = agent.accessor.get(IAgentToolRegistryService).resolve("Bash");
    expect(tool, 'Tool "Bash" not found').toBeDefined();
    const execution = await tool!.resolveExecution({
      command: "printf local_shell_ok",
    });
    if (execution.isError === true)
      throw new Error(JSON.stringify(execution.output));
    const result = await execution.execute({
      turnId: 1,
      toolCallId: "local-after-acp-preview",
      signal: new AbortController().signal,
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.output)).toContain("local_shell_ok");
  }, 30_000);

  it("repairs a persisted ACP binding and reactivates tools when loading", async () => {
    const c = await boot();
    const created = (await c.send("session/new", {
      cwd: homeDir,
      mcpServers: [],
    })) as { sessionId: string };
    await c.server.klient.session(created.sessionId).close();

    const files = await readdir(homeDir!, { recursive: true });
    const wirePath = files.find((path) => path.endsWith("wire.jsonl"))!;
    const records = (await readFile(join(homeDir!, wirePath), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { type?: string; environmentId?: string },
      );
    const index = records.findIndex(
      (record) => record.type === "environment.set_binding",
    );
    expect(index).toBeGreaterThanOrEqual(0);
    records[index]!.environmentId = `acp:${created.sessionId}`;
    await writeFile(
      join(homeDir!, wirePath),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );

    await c.send("session/load", {
      sessionId: created.sessionId,
      cwd: homeDir,
      mcpServers: [],
    });
    expect((await mainBinding(created.sessionId)).current.environmentId).toBe(
      "local",
    );
    const session = getLiveSessionById(
      c.server.core.accessor,
      created.sessionId,
    )!;
    const main = await ensureMainAgent(session);
    const agent = session.accessor
      .get(IAgentLifecycleService)
      .handleOf(main.agentId)!;
    const tool = agent.accessor.get(IAgentToolRegistryService).resolve("Bash");
    expect(tool, 'Tool "Bash" not found after legacy repair').toBeDefined();
    await c.send("session/close", { sessionId: created.sessionId });
    expect(await c.server.klient.session(created.sessionId).restore()).toBe(
      true,
    );
    expect((await mainBinding(created.sessionId)).current.environmentId).toBe(
      "local",
    );
  }, 30_000);

  it("keeps a disconnected remote binding and closes without using it", async () => {
    const c = await boot();
    const remote = fakeEnvironment("test-remote", "one");
    await c.server.core.accessor.get(IEnvironmentService).addProvider({
      id: "test-remote",
      attach: async (host) => {
        host.registerEnvironment(
          Object.assign(remote, {
            fs: new HostFileSystem(),
            process: new HostProcessService(),
          }),
        );
        return { dispose: () => {} };
      },
    });
    const created = await c.server.core.accessor.get(ISessionManager).create({
      workDir: homeDir!,
      environmentId: "test-remote",
      environmentCwd: homeDir,
    });
    await c.send("session/load", {
      sessionId: created.id,
      cwd: homeDir,
      mcpServers: [],
    });
    const session = getLiveSessionById(c.server.core.accessor, created.id)!;
    const main = await ensureMainAgent(session);
    const agent = session.accessor
      .get(IAgentLifecycleService)
      .handleOf(main.agentId)!;
    expect(agent.accessor.get(IAgentEnvironmentBindingService).current).toEqual(
      {
        environmentId: "test-remote",
        cwd: homeDir,
      },
    );
    expect(
      agent.accessor.get(IAgentEnvironmentService).acquire().environment
        .identity.environmentId,
    ).toBe("test-remote");
    const binding = agent.accessor.get(IAgentEnvironmentBindingService);
    remote.setStatus("disconnected");
    await c.send("session/close", { sessionId: created.id });
    expect(binding.current).toEqual({
      environmentId: "test-remote",
      cwd: homeDir,
    });
    remote.setStatus("ready");
    expect(await c.server.klient.session(created.id).restore()).toBe(true);
    expect((await mainBinding(created.id)).current).toEqual({
      environmentId: "test-remote",
      cwd: homeDir,
    });
  }, 30_000);
  it("client close / server shutdown closes all active sessions cleanly", async () => {
    const c = await boot();
    const s1 = (await c.send("session/new", {
      cwd: homeDir,
      mcpServers: [],
    })) as {
      sessionId: string;
    };
    const s2 = (await c.send("session/new", {
      cwd: homeDir,
      mcpServers: [],
    })) as {
      sessionId: string;
    };
    expect(s1.sessionId).toBeDefined();
    expect(s2.sessionId).toBeDefined();
    await expect(c.close()).resolves.toBeUndefined();
  }, 30_000);

  it("server shutdown awaits in-flight session teardowns and cleans up cleanly", async () => {
    const c = await boot();
    const s = (await c.send("session/new", {
      cwd: homeDir,
      mcpServers: [],
    })) as {
      sessionId: string;
    };
    const closeReq = c.send("session/close", { sessionId: s.sessionId });
    const shutdown = c.close();
    await Promise.all([closeReq, shutdown]);
  }, 30_000);

  it("deleteSession following an in-flight closeSession still deletes the session", async () => {
    const c = await boot();
    const s = (await c.send("session/new", {
      cwd: homeDir,
      mcpServers: [],
    })) as {
      sessionId: string;
    };
    const closeReq = c.send("session/close", { sessionId: s.sessionId });
    const deleteReq = c.send("session/delete", { sessionId: s.sessionId });
    await Promise.all([closeReq, deleteReq]);

    await expect(
      c.send("session/delete", { sessionId: s.sessionId }),
    ).rejects.toThrow();
  }, 30_000);

  it("server shutdown drains replacement deleteSession following an in-flight closeSession", async () => {
    const c = await boot();
    const s = (await c.send("session/new", {
      cwd: homeDir,
      mcpServers: [],
    })) as {
      sessionId: string;
    };
    const closeReq = c.send("session/close", { sessionId: s.sessionId });
    const deleteReq = c.send("session/delete", { sessionId: s.sessionId });
    const shutdown = c.close();
    await Promise.all([closeReq, deleteReq, shutdown]);
  }, 30_000);

  it("closeSession succeeds even when concurrent deleteSession for an unknown id fails", async () => {
    const c = await boot();
    const unknownId = "nonexistent-session-id";
    const deleteReq = c.send("session/delete", { sessionId: unknownId });
    const closeReq = c.send("session/close", { sessionId: unknownId });

    await expect(deleteReq).rejects.toThrow();
    await expect(closeReq).resolves.toBeDefined();
  }, 30_000);

  it("automatic server shutdown does not trigger unhandledRejection when session close rejects", async () => {
    let unhandled: unknown;
    const onUnhandled = (err: unknown) => {
      unhandled = err;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const c = await boot();
      const s = (await c.send("session/new", {
        cwd: homeDir,
        mcpServers: [],
      })) as {
        sessionId: string;
      };
      const sessionHandle = c.server.klient.session(s.sessionId);
      vi.spyOn(sessionHandle, "close").mockRejectedValueOnce(
        new Error("forced teardown failure"),
      );
      await c.close().catch(() => {});
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toBeUndefined();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 30_000);
});
