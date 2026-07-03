import assert from "node:assert";
import { describe, it } from "node:test";
import { createHarness, type WriteCapturingTerminal } from "./harness.ts";

// Case 02 — scroll position yanked while reading scrollback.
//
// Symptom: on Windows Terminal, when the transcript collapsed while the
// user was scrolled up reading history, the view jumped to the absolute
// top of scrollback (microsoft/Terminal#20370: ESC[3J while scrolled
// into scrollback).
//
// Root cause: the fallback was a destructive full redraw that cleared
// scrollback with ESC[3J. Fixed in #1315: the collapse repaints only the
// live screen area, never emits ESC[3J, and leaves the scroll position
// alone.

describe("e2e case02: collapse must not yank the user's scroll position", () => {
	it("preserves scroll position and never emits ESC[3J during a collapse", async () => {
		const h = await createHarness([...Array.from({ length: 59 }, (_, i) => `old-${i}`), "[INPUT-BOX]"], {
			rows: 10,
			capture: true,
		});
		const terminal = h.terminal as WriteCapturingTerminal;

		// User scrolls up into scrollback and starts reading.
		terminal.scrollViewport(-20);
		const scrolledPosition = terminal.getScrollPosition();
		assert.ok(terminal.getViewport().some((line) => line.includes("old-35")));

		terminal.writes = [];
		await h.frame(["new-0", "new-1", "new-2", "new-3", "new-4", "new-5", "new-6", "[INPUT-BOX]"]);

		assert.strictEqual(terminal.getScrollPosition(), scrolledPosition, "scroll position must be preserved");
		assert.ok(
			terminal.getViewport().some((line) => line.includes("old-35")),
			"the user's scrolled view must still show the history",
		);
		assert.ok(
			!terminal.writes.join("").includes("\x1b[3J"),
			"a collapse must never clear scrollback with ESC[3J",
		);

		// Scrolling back down reveals the fresh content.
		terminal.scrollToBottom();
		const viewport = terminal.getViewport();
		assert.ok(
			viewport.some((line) => line.includes("[INPUT-BOX]")),
			`input box must be at the bottom after scrolling down, got: ${JSON.stringify(viewport)}`,
		);

		h.stop();
	});
});
