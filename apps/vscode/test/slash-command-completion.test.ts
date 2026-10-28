import { describe, expect, it } from "vitest";
import { computeSlashCommandInsert } from "../webview-ui/src/components/inputarea/slash-command-insert";

describe("slash command completion", () => {
  it("replaces only the active token and leaves the command ready for arguments", () => {
    expect(
      computeSlashCommandInsert({
        text: "Please /rev later",
        cursorPos: 11,
        activeToken: { start: 7 },
        commandName: "review",
      }),
    ).toEqual({ text: "Please /review later", cursorPos: 15 });
  });

  it("inserts one separator before an adjacent suffix", () => {
    expect(
      computeSlashCommandInsert({
        text: "/revLater",
        cursorPos: 4,
        activeToken: { start: 0 },
        commandName: "review",
      }),
    ).toEqual({ text: "/review Later", cursorPos: 8 });
  });

  it("adds one separator after a completed command at the end of the input", () => {
    expect(
      computeSlashCommandInsert({
        text: "/ski",
        cursorPos: 4,
        activeToken: { start: 0 },
        commandName: "skill:review",
      }),
    ).toEqual({ text: "/skill:review ", cursorPos: 14 });
  });
});
