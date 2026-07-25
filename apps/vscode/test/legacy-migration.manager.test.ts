/**
 * Scenario: VS Code discovers and runs legacy kimi-cli migration without touching a real home.
 * Responsibilities: source selection, shared-marker suppression, real migration, retry, and clear reports.
 * Wiring: real temporary files and the public migration package; no stubbed collaborators.
 * Run: pnpm --filter kimi-code test -- legacy-migration.manager.test.ts
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LegacyMigrationManager } from "../src/migration";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("legacy migration manager (discovery and migration coordination)", () => {
  it("returns an actionable prompt when the default legacy home contains data", async () => {
    const rig = await createRig();
    await writeLegacyConfig(rig.sourceHome);

    const discovery = await rig.manager.discover();

    expect(discovery.prompt).toMatchObject({
      kind: "legacy-migration",
      actions: [
        { id: "now", label: "Migrate Now" },
        { id: "later", label: "Later" },
      ],
      sources: [
        {
          sourceHome: rig.sourceHome,
          origin: "default",
          hasConfig: true,
        },
      ],
    });
  });

  it("suppresses the prompt when the shared marker names the same target", async () => {
    const rig = await createRig();
    await writeLegacyConfig(rig.sourceHome);
    await writeSharedMarker(rig.sourceHome, rig.targetHome);

    const discovery = await rig.manager.discover();

    expect(discovery.prompt).toBeNull();
    expect(discovery.suppressedSources).toEqual([
      expect.objectContaining({ sourceHome: rig.sourceHome, hasConfig: true }),
    ]);
  });

  it("returns the prompt when the shared marker names a different target", async () => {
    const rig = await createRig();
    await writeLegacyConfig(rig.sourceHome);
    await writeSharedMarker(rig.sourceHome, join(rig.root, "another-target"));

    const discovery = await rig.manager.discover();

    expect(discovery.prompt?.sources).toEqual([
      expect.objectContaining({ sourceHome: rig.sourceHome }),
    ]);
  });

  it("does not duplicate data when the TUI already migrated the same source", async () => {
    const rig = await createRig();
    await writeLegacyConfig(rig.sourceHome);
    const existingSession = join(rig.targetHome, "sessions", "existing", "state.json");
    await mkdir(join(existingSession, ".."), { recursive: true });
    await writeFile(existingSession, '{"custom":{"imported_from_kimi_cli":true}}');
    await writeSharedMarker(rig.sourceHome, rig.targetHome);

    const result = await rig.manager.migrateNow();

    expect(result.status).toBe("nothing-to-migrate");
    await expect(readFile(existingSession, "utf-8")).resolves.toContain(
      "imported_from_kimi_cli",
    );
    await expect(readFile(join(rig.targetHome, "config.toml"), "utf-8")).rejects.toThrow();
  });

  it("conservatively suppresses the prompt when the shared marker is corrupt", async () => {
    const rig = await createRig();
    await writeLegacyConfig(rig.sourceHome);
    await writeFile(join(rig.sourceHome, ".migrated-to-kimi-code"), "not-json");

    const discovery = await rig.manager.discover();

    expect(discovery.prompt).toBeNull();
    expect(discovery.suppressedSources).toHaveLength(1);
  });

  it("discovers a relative legacy KIMI_SHARE_DIR from the workspace and warns about its resolution", async () => {
    const rig = await createRig({
      legacyEnvironmentVariables: { KIMI_SHARE_DIR: "legacy-kimi" },
    });
    const shareHome = join(rig.workspaceRoot, "legacy-kimi");
    await writeLegacyConfig(shareHome);

    const discovery = await rig.manager.discover();

    expect(discovery.prompt?.sources).toEqual([
      expect.objectContaining({
        sourceHome: resolve(shareHome),
        origin: "legacy-vscode-setting",
      }),
    ]);
    expect(discovery.warnings).toEqual([
      expect.objectContaining({ code: "relative-share-dir", sourceHome: resolve(shareHome) }),
    ]);
  });

  it("migrates both the default home and the extra legacy KIMI_SHARE_DIR source", async () => {
    const rig = await createRig({
      legacyEnvironmentVariables: { KIMI_SHARE_DIR: "legacy-kimi" },
    });
    await writeLegacyConfig(rig.sourceHome);
    const shareHome = join(rig.workspaceRoot, "legacy-kimi");
    await mkdir(join(shareHome, "skills", "example-skill"), { recursive: true });
    await writeFile(
      join(shareHome, "skills", "example-skill", "SKILL.md"),
      "---\nname: example-skill\ndescription: test fixture\n---\n",
    );

    const result = await rig.manager.retry();

    expect(result.status).toBe("completed");
    expect(result.sources).toHaveLength(2);
    expect(result.totals).toMatchObject({ configFiles: 1, skills: 1 });
    await expect(
      readFile(join(rig.targetHome, "skills", "example-skill", "SKILL.md"), "utf-8"),
    ).resolves.toContain("example-skill");
  });

  it("ignores legacy environment variables other than KIMI_SHARE_DIR", async () => {
    const rig = await createRig({
      legacyEnvironmentVariables: {
        KIMI_CODE_HOME: join(tmpdir(), "must-not-be-read"),
        PATH: join(tmpdir(), "must-not-be-used"),
      },
    });

    const discovery = await rig.manager.discover();

    expect(discovery).toMatchObject({ prompt: null, warnings: [] });
  });

  it("ignores a non-string legacy KIMI_SHARE_DIR with a clear warning", async () => {
    const rig = await createRig({
      legacyEnvironmentVariables: { KIMI_SHARE_DIR: 42, HTTPS_PROXY: "https://example.test" },
    });

    const discovery = await rig.manager.discover();

    expect(discovery.prompt).toBeNull();
    expect(discovery.warnings).toEqual([
      expect.objectContaining({
        code: "invalid-share-dir",
        message: expect.stringContaining("non-empty string"),
      }),
    ]);
  });

  it("ignores a relative legacy KIMI_SHARE_DIR when no workspace can resolve it", async () => {
    const rig = await createRig({
      workspaceRoot: null,
      legacyEnvironmentVariables: { KIMI_SHARE_DIR: "legacy-kimi" },
    });

    const discovery = await rig.manager.discover();

    expect(discovery.prompt).toBeNull();
    expect(discovery.warnings).toEqual([
      expect.objectContaining({
        code: "invalid-share-dir",
        message: expect.stringContaining("no workspace is open"),
      }),
    ]);
  });

  it("bypasses a completed marker on explicit retry and runs the real migration", async () => {
    const rig = await createRig();
    await writeLegacyConfig(rig.sourceHome);
    await writeSharedMarker(rig.sourceHome, rig.targetHome);

    const result = await rig.manager.retry();

    expect(result.status).toBe("completed");
    expect(result.totals.configFiles).toBe(1);
    await expect(readFile(join(rig.targetHome, "config.toml"), "utf-8")).resolves.toContain(
      "merge_all_available_skills",
    );
  });

  it("keeps the migrated target unchanged when an explicit retry is repeated", async () => {
    const rig = await createRig();
    await writeLegacyConfig(rig.sourceHome);
    await rig.manager.retry();
    const firstTarget = await readFile(join(rig.targetHome, "config.toml"), "utf-8");

    const secondResult = await rig.manager.retry();

    expect(secondResult.status).toBe("completed");
    await expect(readFile(join(rig.targetHome, "config.toml"), "utf-8")).resolves.toBe(
      firstTarget,
    );
  });

  it("reports a corrupt session as a partial migration without rolling back valid data", async () => {
    const rig = await createRig();
    await writeLegacyConfig(rig.sourceHome);
    await writeCorruptLegacySession(rig.sourceHome, rig.workspaceRoot);

    const result = await rig.manager.retry();

    expect(result.status).toBe("partial");
    expect(result.sources[0]?.failures).toEqual([
      expect.objectContaining({
        code: "session-failed",
        message: expect.stringMatching(/corrupt|parseable/i),
      }),
    ]);
    await expect(readFile(join(rig.targetHome, "config.toml"), "utf-8")).resolves.toContain(
      "merge_all_available_skills",
    );
  });

  it("discovers an unknown workdir bucket as actionable legacy data", async () => {
    const rig = await createRig();
    const bucket = await writeUnknownWorkdirBucket(rig.sourceHome);

    const discovery = await rig.manager.discover();

    expect(discovery.prompt?.sources).toEqual([
      expect.objectContaining({
        sourceHome: rig.sourceHome,
        totalSessions: 0,
        sessionIssues: 1,
      }),
    ]);
    expect(discovery.warnings).toEqual([
      expect.objectContaining({
        code: "legacy-session-unreadable",
        message: expect.stringContaining(bucket),
      }),
    ]);
  });

  it("returns a partial result with a manual action for an unknown workdir bucket", async () => {
    const rig = await createRig();
    const bucket = await writeUnknownWorkdirBucket(rig.sourceHome);

    const result = await rig.manager.retry();

    expect(result.status).toBe("partial");
    expect(result.sources[0]?.failures).toEqual([
      expect.objectContaining({ code: "session-failed", item: bucket }),
    ]);
    expect(result.manualActions).toEqual([expect.stringContaining(bucket)]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "legacy-session-unreadable" }),
    ]);
  });

  it("returns a partial result with a warning when a registered bucket is unreadable", async () => {
    const rig = await createRig();
    const workDir = rig.workspaceRoot;
    await mkdir(rig.sourceHome, { recursive: true });
    await writeFile(
      join(rig.sourceHome, "kimi.json"),
      JSON.stringify({ work_dirs: [{ path: workDir, kaos: "local" }] }),
    );
    const bucket = join(
      rig.sourceHome,
      "sessions",
      createHash("md5").update(workDir).digest("hex"),
    );
    await mkdir(join(rig.sourceHome, "sessions"), { recursive: true });
    await writeFile(bucket, "not a directory");

    const result = await rig.manager.retry();

    expect(result.status).toBe("partial");
    expect(result.sources[0]?.failures).toEqual([
      expect.objectContaining({ code: "session-failed", item: bucket }),
    ]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "legacy-session-unreadable",
        message: expect.stringContaining(bucket),
      }),
    ]);
  });

  it("keeps an unresolved session source discoverable after a partial run", async () => {
    const rig = await createRig();
    await writeUnknownWorkdirBucket(rig.sourceHome);
    await rig.manager.retry();

    const discovery = await rig.manager.discover();

    expect(discovery.prompt?.sources).toEqual([
      expect.objectContaining({ sourceHome: rig.sourceHome, sessionIssues: 1 }),
    ]);
  });

  it("reports an unresolved session warning when a shared marker suppresses the prompt", async () => {
    const rig = await createRig();
    const bucket = await writeUnknownWorkdirBucket(rig.sourceHome);
    await writeSharedMarker(rig.sourceHome, rig.targetHome);

    const discovery = await rig.manager.discover();

    expect(discovery.prompt).toBeNull();
    expect(discovery.suppressedSources).toEqual([
      expect.objectContaining({ sourceHome: rig.sourceHome, sessionIssues: 1 }),
    ]);
    expect(discovery.warnings).toEqual([
      expect.objectContaining({
        code: "legacy-session-unreadable",
        message: expect.stringContaining(bucket),
      }),
    ]);
  });

  it("reports an unparseable legacy config with a manual review action", async () => {
    const rig = await createRig();
    await mkdir(rig.sourceHome, { recursive: true });
    await writeFile(join(rig.sourceHome, "config.toml"), 'broken = "unterminated');

    const result = await rig.manager.retry();

    expect(result.status).toBe("partial");
    expect(result.sources[0]?.failures).toEqual([
      expect.objectContaining({ code: "legacy-config-unreadable", item: "config.toml" }),
    ]);
    expect(result.manualActions).toEqual([
      expect.stringContaining("review it manually"),
    ]);
  });

  it("reports an unparseable legacy MCP file with a manual review action", async () => {
    const rig = await createRig();
    await mkdir(rig.sourceHome, { recursive: true });
    await writeFile(join(rig.sourceHome, "mcp.json"), "{broken");

    const result = await rig.manager.retry();

    expect(result.status).toBe("partial");
    expect(result.sources[0]?.failures).toEqual([
      expect.objectContaining({ code: "legacy-mcp-unreadable", item: "mcp.json" }),
    ]);
  });

  it("returns a failed result with the original filesystem reason when the target is blocked", async () => {
    const rig = await createRig();
    await writeLegacyConfig(rig.sourceHome);
    await writeFile(rig.targetHome, "this file blocks the target directory");

    const result = await rig.manager.retry();

    expect(result.status).toBe("failed");
    expect(result.sources[0]?.failures).toEqual([
      expect.objectContaining({
        code: "run-failed",
        message: expect.stringMatching(/file|directory|exist|not a directory/i),
      }),
    ]);
    expect(result.manualActions).toEqual([
      expect.stringContaining("Migrate Legacy Data"),
    ]);
  });

  it("reports legacy OAuth login as requiring a new login without treating it as migratable data", async () => {
    const rig = await createRig();
    await mkdir(join(rig.sourceHome, "credentials"), { recursive: true });
    await writeFile(join(rig.sourceHome, "credentials", "kimi-code.json"), "{}");

    const discovery = await rig.manager.discover();

    expect(discovery.prompt).toBeNull();
    expect(discovery.notices.oauthLoginsRequiringRelogin).toEqual([
      { sourceHome: rig.sourceHome, name: "kimi-code.json" },
    ]);
  });

  it("reports legacy MCP OAuth state as requiring reauthorization", async () => {
    const rig = await createRig();
    await mkdir(join(rig.sourceHome, "mcp-oauth"), { recursive: true });
    await writeFile(join(rig.sourceHome, "mcp-oauth", "example-server"), "{}");

    const discovery = await rig.manager.discover();

    expect(discovery.notices.mcpOauthServersRequiringReauth).toEqual([
      { sourceHome: rig.sourceHome, name: "example-server" },
    ]);
  });

  it("reports a configured migration source that is not a directory", async () => {
    const rig = await createRig();
    await writeFile(rig.sourceHome, "not a directory");

    const discovery = await rig.manager.discover();

    expect(discovery.warnings).toEqual([
      expect.objectContaining({
        code: "source-not-directory",
        sourceHome: rig.sourceHome,
      }),
    ]);
  });
});

interface RigOptions {
  readonly workspaceRoot?: string | null;
  readonly legacyEnvironmentVariables?: unknown;
}

async function createRig(options: RigOptions = {}): Promise<{
  readonly root: string;
  readonly sourceHome: string;
  readonly targetHome: string;
  readonly workspaceRoot: string;
  readonly manager: LegacyMigrationManager;
}> {
  const root = await mkdtemp(join(tmpdir(), "vscode-legacy-migration-"));
  temporaryRoots.push(root);
  const sourceHome = join(root, ".kimi");
  const targetHome = join(root, ".kimi-code");
  const workspaceRoot = join(root, "workspace");
  await mkdir(options.workspaceRoot === null ? root : workspaceRoot, { recursive: true });
  const manager = new LegacyMigrationManager({
    targetHome,
    defaultSourceHome: sourceHome,
    workspaceRoot: options.workspaceRoot === undefined ? workspaceRoot : options.workspaceRoot,
    legacyEnvironmentVariables: options.legacyEnvironmentVariables,
  });
  return { root, sourceHome, targetHome, workspaceRoot, manager };
}

async function writeLegacyConfig(sourceHome: string): Promise<void> {
  await mkdir(sourceHome, { recursive: true });
  await writeFile(join(sourceHome, "config.toml"), "merge_all_available_skills = true\n");
}

async function writeSharedMarker(sourceHome: string, targetHome: string): Promise<void> {
  await mkdir(sourceHome, { recursive: true });
  await writeFile(
    join(sourceHome, ".migrated-to-kimi-code"),
    JSON.stringify({ version: 1, target_path: targetHome, runs: [] }),
  );
}

async function writeCorruptLegacySession(
  sourceHome: string,
  workDir: string,
): Promise<void> {
  await mkdir(sourceHome, { recursive: true });
  await writeFile(
    join(sourceHome, "kimi.json"),
    JSON.stringify({ work_dirs: [{ path: workDir, kaos: "local" }] }),
  );
  const bucket = createHash("md5").update(workDir).digest("hex");
  const sessionDir = join(sourceHome, "sessions", bucket, "corrupt-session");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "context.jsonl"), "not-json\n{broken\n}}}\n");
  await writeFile(join(sessionDir, "state.json"), "{}");
}

async function writeUnknownWorkdirBucket(sourceHome: string): Promise<string> {
  const bucket = join(
    sourceHome,
    "sessions",
    createHash("md5").update("/workspace/not-registered").digest("hex"),
  );
  await mkdir(join(bucket, "legacy-session"), { recursive: true });
  await writeFile(
    join(bucket, "legacy-session", "context.jsonl"),
    '{"role":"user","content":"hello"}\n',
  );
  return bucket;
}
