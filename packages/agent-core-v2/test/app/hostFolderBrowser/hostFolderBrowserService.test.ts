import * as fsPromises from "node:fs/promises";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IProjectService } from "#/app/project/project";
import { HostFolderBrowser } from "#/app/hostFolderBrowser/hostFolderBrowserService";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: vi.fn((...args: Parameters<typeof actual.stat>) =>
      actual.stat(...args),
    ),
  };
});

const fakeRegistry = {
  list: async () => [],
} as unknown as IProjectService;

describe("HostFolderBrowser", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    while (dirs.length > 0) {
      const dir = dirs.pop()!;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("includes symlinked directories and skips broken, looped, and file symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-folder-browser-"));
    dirs.push(root);

    const projects = join(root, "projects");
    const external = join(root, "external");
    const targetDir = join(projects, "real-dir");
    const targetFile = join(root, "file.txt");

    await mkdir(projects, { recursive: true });
    await mkdir(external, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await writeFile(targetFile, "hello", "utf8");

    await symlink(targetDir, join(projects, "internal-link"));
    await symlink(external, join(projects, "external-link"));
    await symlink(targetFile, join(projects, "file-link"));
    await symlink(join(root, "missing-target"), join(projects, "broken-link"));
    await symlink(join(projects, "loop-b"), join(projects, "loop-a"));
    await symlink(join(projects, "loop-a"), join(projects, "loop-b"));

    const browser = new HostFolderBrowser(fakeRegistry);
    const res = await browser.browse(projects);

    expect(res.entries.map((e) => e.name)).toEqual([
      "external-link",
      "internal-link",
      "real-dir",
    ]);
    expect(res.entries.every((e) => e.is_dir)).toBe(true);

    const nav = await browser.browse(join(projects, "external-link"));
    expect(nav.entries).toEqual([]);
  });

  it("propagates unexpected stat errors instead of hiding symlinked directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-folder-browser-eio-"));
    dirs.push(root);

    const projects = join(root, "projects");
    const targetDir = join(root, "target");
    await mkdir(projects, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await symlink(targetDir, join(projects, "link-dir"));

    vi.mocked(fsPromises.stat).mockRejectedValueOnce(
      Object.assign(new Error("I/O error"), { code: "EIO" }),
    );

    const browser = new HostFolderBrowser(fakeRegistry);
    await expect(browser.browse(projects)).rejects.toMatchObject({
      code: "EIO",
    });
  });
});
