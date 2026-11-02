import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/exit-without-stop.ts", import.meta.url));

function runFixture(mode: "exit" | "stop", tmux = false): string {
	const result = spawnSync(process.execPath, [fixture, mode], {
		encoding: "utf8",
		env: {
			...process.env,
			TMUX: tmux ? "/tmp/tmux-test/default,1,0" : undefined,
			STY: undefined,
			ZELLIJ: undefined,
			TERM: "xterm-256color",
			PI_PROGRAM_STATUS: "1",
		},
		stdio: ["pipe", "pipe", "pipe"],
		timeout: 10_000,
	});
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

function count(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

// Regression for #11170: exit paths that skip stop() left mouse tracking, focus reporting,
// the Kitty keyboard protocol, bracketed paste, and the alternate screen enabled.
describe("terminal restore on process exit", () => {
	const programStatusClear = "\x1b]7501;state=clear\x1b\\";
	it("restores terminal modes when the process exits without stop()", () => {
		const output = runFixture("exit");
		for (const sequence of ["\x1b[?1006l", "\x1b[?1004l", "\x1b[?1003l", "\x1b[?1000l", "\x1b[<u", "\x1b[?2004l"]) {
			assert.equal(count(output, sequence), 1, JSON.stringify(sequence));
		}
		assert.ok(output.indexOf("\x1b[<u") < output.indexOf("\x1b[?1049l"), "Kitty pop must precede leaving alt screen");
		assert.equal(count(output, programStatusClear), 1);
		assert.ok(output.endsWith("\x1b[?1049l\x1b[?25h"));
	});

	it("wraps the program status clear in tmux passthrough on direct exit", () => {
		const output = runFixture("exit", true);
		const tmuxClear = "\x1bPtmux;\x1b\x1b]7501;state=clear\x1b\x1b\\\x1b\\";
		assert.equal(count(output, tmuxClear), 1);
		assert.equal(count(output, programStatusClear), 0);
	});

	it("does not restore twice after a normal stop()", () => {
		const output = runFixture("stop");
		for (const sequence of ["\x1b[?1006l", "\x1b[?1004l", "\x1b[<u", "\x1b[?2004l", "\x1b[?1049l"]) {
			assert.equal(count(output, sequence), 1, JSON.stringify(sequence));
		}
		assert.equal(count(output, programStatusClear), 1);
	});
});
