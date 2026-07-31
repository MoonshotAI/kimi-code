/**
 * Scenario: resources dragged from VS Code's Explorer into the chat webview.
 * Responsibility: decode the standard URI list and present workspace resources
 * as relative paths while retaining usable absolute paths for external files.
 * Run: pnpm exec vitest run --config apps/vscode/vitest.config.ts test/path-drop.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  insertDroppedFilePaths,
  parseDroppedFilePaths,
  resolveDroppedContent,
} from "../webview-ui/src/components/inputarea/path-drop";

describe("parseDroppedFilePaths", () => {
  it("decodes Explorer URI lists and makes workspace paths relative", () => {
    const uriList = [
      "# VS Code resources",
      "file:///work/project/src/User%20Service.ts#L4,2",
      "file:///work/project/docs",
      "",
    ].join("\r\n");

    expect(parseDroppedFilePaths(uriList, "/work/project")).toEqual([
      "src/User Service.ts",
      "docs",
    ]);
  });

  it("keeps external paths absolute and ignores non-file resources", () => {
    const uriList = [
      "https://example.com/not-a-file",
      "file:///other/project/readme.md",
      "not a URI",
    ].join("\n");

    expect(parseDroppedFilePaths(uriList, "/work/project")).toEqual([
      "/other/project/readme.md",
    ]);
  });

  it("supports Windows workspace paths case-insensitively", () => {
    expect(
      parseDroppedFilePaths("file:///C:/Users/Ada/Project/src/main.ts", "c:\\Users\\Ada\\Project"),
    ).toEqual(["src/main.ts"]);
  });

  it("does not treat a sibling directory with the same prefix as workspace-relative", () => {
    expect(
      parseDroppedFilePaths("file:///work/project-copy/file.ts", "/work/project"),
    ).toEqual(["/work/project-copy/file.ts"]);
  });

  it("represents the dropped workspace root as the current directory", () => {
    expect(parseDroppedFilePaths("file:///", "/")).toEqual(["."]);
    expect(parseDroppedFilePaths("file:///C:/", "C:\\")).toEqual(["."]);
  });

  it("accepts resources from the active remote workspace", () => {
    expect(parseDroppedFilePaths(
      "vscode-remote://ssh-remote+devbox/home/ada/project/packages/app/src/main.ts",
      "/home/ada/project/packages/app",
      "vscode-remote://ssh-remote+devbox/home/ada/project",
    )).toEqual(["src/main.ts"]);
  });

  it("rejects remote resources from a different workspace authority", () => {
    const workspaceUri = "vscode-remote://ssh-remote+devbox/home/ada/project";
    const uriList = [
      "vscode-remote://ssh-remote+other/home/ada/project/file.ts",
      "vscode-remote://unexpected@ssh-remote+devbox/home/ada/project/file.ts",
      "https://ssh-remote+devbox/home/ada/project/file.ts",
    ].join("\n");

    expect(parseDroppedFilePaths(uriList, "/home/ada/project", workspaceUri)).toEqual([]);
  });
});

describe("insertDroppedFilePaths", () => {
  it("inserts mentions at the caret without replacing surrounding text", () => {
    expect(insertDroppedFilePaths("Review  please", 7, ["src/a.ts", "docs"])).toEqual({
      text: "Review @src/a.ts @docs please",
      cursorPos: 23,
    });
  });

  it("quotes the same space-containing path form used by editor mentions", () => {
    expect(insertDroppedFilePaths("", 0, ["src/User Service.ts"])).toEqual({
      text: '@"src/User Service.ts" ',
      cursorPos: 23,
    });
  });
});

describe("resolveDroppedContent", () => {
  function transfer(files: File[], uriList: string) {
    return {
      files,
      getData: (mimeType: string) => mimeType === "text/uri-list" ? uriList : "",
    };
  }

  it("preserves media upload when a drop also contains a URI list", () => {
    const image = new File(["image"], "diagram.png", { type: "image/png" });
    const dropped = resolveDroppedContent(
      transfer([image], "file:///work/project/diagram.png"),
      "/work/project",
      null,
      (file) => file.type.startsWith("image/"),
    );

    expect(dropped).toEqual({ kind: "media", files: [image] });
  });

  it("uses Explorer paths when no media file is present", () => {
    const source = new File(["source"], "main.ts", { type: "text/typescript" });
    expect(resolveDroppedContent(
      transfer([source], "file:///work/project/src/main.ts"),
      "/work/project",
      null,
      (file) => file.type.startsWith("image/"),
    )).toEqual({ kind: "paths", paths: ["src/main.ts"] });
  });
});
