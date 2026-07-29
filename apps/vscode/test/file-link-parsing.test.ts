/**
 * Scenario: markdown link hrefs in assistant output → local file-link targets.
 * Responsibilities: external links stay anchors, local paths (plain, file://,
 * vscode://file/, with optional :line suffix) resolve to an openFile target,
 * and the url transform preserves the schemes the sanitizer would drop.
 * Wiring: pure helpers, no VS Code host involved.
 * Run: pnpm --filter kimi-code exec vitest run --config vitest.config.ts test/file-link-parsing.test.ts
 */
import { describe, expect, it } from "vitest";
import { fileAwareUrlTransform, parseFileLink } from "@/lib/link-utils";

describe("parseFileLink", () => {
  it("parses an absolute path with a line suffix", () => {
    expect(parseFileLink("/abs/path/report.md:33")).toEqual({ path: "/abs/path/report.md", line: 33 });
  });

  it("parses an absolute path without a line suffix", () => {
    expect(parseFileLink("/abs/path/report.md")).toEqual({ path: "/abs/path/report.md" });
  });

  it("parses a relative path with a line:column suffix", () => {
    expect(parseFileLink("src/app.ts:12:5")).toEqual({ path: "src/app.ts", line: 12 });
  });

  it("parses a root-level relative path with a line suffix", () => {
    expect(parseFileLink("README.md:5")).toEqual({ path: "README.md", line: 5 });
    expect(parseFileLink("app.ts:12")).toEqual({ path: "app.ts", line: 12 });
  });

  it("keeps a :0 suffix as part of the path instead of a line reference", () => {
    expect(parseFileLink("app.ts:0")).toEqual({ path: "app.ts:0" });
  });

  it("keeps an unsafely large line suffix as part of the path", () => {
    expect(parseFileLink("app.ts:99999999999999999999")).toEqual({ path: "app.ts:99999999999999999999" });
  });

  it("does not treat other vscode authorities as file links", () => {
    expect(parseFileLink("vscode://fileevil/path.ts")).toBeNull();
    expect(parseFileLink("vscode://file")).toBeNull();
  });

  it("parses a file URI with a line suffix", () => {
    expect(parseFileLink("file:///abs/path/report.md:33")).toEqual({ path: "/abs/path/report.md", line: 33 });
  });

  it("parses a Windows drive file URI with percent-encoding", () => {
    expect(parseFileLink("file:///C:/proj/file%20name.ts")).toEqual({ path: "C:/proj/file name.ts" });
  });

  it("parses a vscode file URI", () => {
    expect(parseFileLink("vscode://file/abs/path/report.md:33")).toEqual({ path: "/abs/path/report.md", line: 33 });
  });

  it("parses a Windows drive vscode file URI without a bogus leading slash", () => {
    expect(parseFileLink("vscode://file/C:/proj/file.ts:7")).toEqual({ path: "C:/proj/file.ts", line: 7 });
  });

  it("parses an authority-bearing file URI as a UNC path", () => {
    expect(parseFileLink("file://server/share/project/file.ts")).toEqual({ path: "//server/share/project/file.ts" });
  });

  it("treats a localhost file URI authority as none", () => {
    expect(parseFileLink("file://localhost/abs/report.md")).toEqual({ path: "/abs/report.md" });
  });

  it("splits fragments off the path and reads GitHub-style line fragments", () => {
    expect(parseFileLink("README.md#usage")).toEqual({ path: "README.md" });
    expect(parseFileLink("src/app.ts#L20")).toEqual({ path: "src/app.ts", line: 20 });
    expect(parseFileLink("app.ts:12#L99")).toEqual({ path: "app.ts", line: 12 });
    expect(parseFileLink("file:///abs/report.md#L2")).toEqual({ path: "/abs/report.md", line: 2 });
  });

  it("parses a native Windows path with a line suffix", () => {
    expect(parseFileLink("C:\\proj\\file.ts:7")).toEqual({ path: "C:\\proj\\file.ts", line: 7 });
  });

  it("returns null for external and non-file links", () => {
    expect(parseFileLink("https://example.com/report.md")).toBeNull();
    expect(parseFileLink("http://example.com")).toBeNull();
    expect(parseFileLink("mailto:someone@example.com")).toBeNull();
    expect(parseFileLink("javascript:alert(1)")).toBeNull();
    expect(parseFileLink("data:text/plain;base64,eA==")).toBeNull();
    expect(parseFileLink("vscode://settings/editor")).toBeNull();
    expect(parseFileLink("//example.com/report.md")).toBeNull();
    expect(parseFileLink("#section")).toBeNull();
    expect(parseFileLink("")).toBeNull();
    expect(parseFileLink(undefined)).toBeNull();
  });
});

describe("fileAwareUrlTransform", () => {
  it("preserves file and vscode-file URLs the default sanitizer would drop", () => {
    expect(fileAwareUrlTransform("file:///abs/report.md:33")).toBe("file:///abs/report.md:33");
    expect(fileAwareUrlTransform("vscode://file/abs/report.md")).toBe("vscode://file/abs/report.md");
  });

  it("keeps http(s) links and plain paths intact", () => {
    expect(fileAwareUrlTransform("https://example.com/x")).toBe("https://example.com/x");
    expect(fileAwareUrlTransform("src/app.ts:12")).toBe("src/app.ts:12");
    expect(fileAwareUrlTransform("/abs/path.md:3")).toBe("/abs/path.md:3");
    expect(fileAwareUrlTransform("C:\\proj\\file.ts:7")).toBe("C:\\proj\\file.ts:7");
  });

  it("preserves root-level relative paths with a line suffix the sanitizer reads as a protocol", () => {
    expect(fileAwareUrlTransform("README.md:5")).toBe("README.md:5");
    expect(fileAwareUrlTransform("app.ts:12")).toBe("app.ts:12");
  });

  it("keeps the default sanitizer for non-href attributes such as image src", () => {
    expect(fileAwareUrlTransform("file:///abs/img.png", "src")).toBe("");
    expect(fileAwareUrlTransform("media/pic.png", "src")).toBe("media/pic.png");
    expect(fileAwareUrlTransform("https://example.com/pic.png", "src")).toBe("https://example.com/pic.png");
  });

  it("still drops javascript URLs", () => {
    expect(fileAwareUrlTransform("javascript:alert(1)")).toBe("");
  });
});
