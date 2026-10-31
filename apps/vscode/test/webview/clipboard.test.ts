import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "@/lib/clipboard";

const boundary = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
}));

vi.mock("@/services", () => ({
  bridge: {
    copyToClipboard: boundary.copyToClipboard,
  },
}));

describe("copyToClipboard helper", () => {
  beforeEach(() => {
    boundary.copyToClipboard.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true immediately for empty text without calling bridge", async () => {
    const success = await copyToClipboard("");
    expect(success).toBe(true);
    expect(boundary.copyToClipboard).not.toHaveBeenCalled();
  });

  it("uses navigator.clipboard.writeText when it succeeds", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true,
    });

    const success = await copyToClipboard("test content");
    expect(success).toBe(true);
    expect(writeTextMock).toHaveBeenCalledWith("test content");
    expect(boundary.copyToClipboard).not.toHaveBeenCalled();
  });

  it("falls back to bridge.copyToClipboard when navigator.clipboard throws NotAllowedError", async () => {
    const writeTextMock = vi.fn().mockRejectedValue(new Error("Document is not focused"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true,
    });
    boundary.copyToClipboard.mockResolvedValue({ ok: true });

    const success = await copyToClipboard("fallback to bridge");
    expect(success).toBe(true);
    expect(writeTextMock).toHaveBeenCalledWith("fallback to bridge");
    expect(boundary.copyToClipboard).toHaveBeenCalledWith("fallback to bridge");
  });

  it("falls back to document.execCommand when bridge fails", async () => {
    const writeTextMock = vi.fn().mockRejectedValue(new Error("Document is not focused"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true,
    });
    boundary.copyToClipboard.mockRejectedValue(new Error("Bridge error"));

    const execCommandMock = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      value: execCommandMock,
      configurable: true,
      writable: true,
    });

    const success = await copyToClipboard("fallback to execCommand");
    expect(success).toBe(true);
    expect(execCommandMock).toHaveBeenCalledWith("copy");
  });
});
