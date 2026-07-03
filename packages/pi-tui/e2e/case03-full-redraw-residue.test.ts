import assert from "node:assert";
import { describe, it } from "node:test";
import { countInBuffer, createHarness } from "./harness.ts";

// Case 03 — stale text above the welcome banner; duplicated rows after
// expansion toggles.
//
// Symptom (a): after /new, /clear, or a session switch, the new session's
// welcome banner rendered with the previous session's text still visible
// above it.
// Symptom (b): pressing ctrl+o to expand collapsed tool output rendered a
// duplicated copy of earlier content above the transcript.
//
// Root cause: both flows replace the content wholesale, which the
// differential renderer cannot reconcile against an unrelated previous
// frame. Fixed in #1315 at the app layer: kimi-code calls
// `requestRender(true)` on session reset and on expansion toggles. This
// case guards the TUI primitive those fixes rely on: a forced render
// repaints the screen from scratch, leaving no residue and no duplicates
// in the visible viewport.

describe("e2e case03: forced full redraw leaves no residue on screen", () => {
	it("clears previous-session text from the screen on a forced render (/clear)", async () => {
		const h = await createHarness([...Array.from({ length: 59 }, (_, i) => `old-${i}`), "[INPUT-BOX]"], {
			rows: 10,
		});

		// Session switch: unrelated short content + forced full redraw.
		await h.frame(["[WELCOME]", "", "[INPUT-BOX]"], true);

		const viewport = h.terminal.getViewport();
		assert.ok(viewport.some((line) => line.includes("[WELCOME]")), "welcome banner must be visible");
		assert.ok(viewport.some((line) => line.includes("[INPUT-BOX]")), "input box must be visible");
		assert.ok(
			!viewport.some((line) => line.includes("old-")),
			`no previous-session text may remain on screen, got: ${JSON.stringify(viewport)}`,
		);

		h.stop();
	});

	it("renders expanded content exactly once on a forced render (ctrl+o)", async () => {
		const collapsed = [
			...Array.from({ length: 40 }, (_, i) => `line-${i}`),
			"... (100 more lines, ctrl+o to expand)",
			"[INPUT-BOX]",
		];
		const h = await createHarness(collapsed, { rows: 10 });

		// Expansion regrows the transcript wholesale + forced full redraw.
		const expanded = [
			...Array.from({ length: 40 }, (_, i) => `line-${i}`),
			...Array.from({ length: 20 }, (_, i) => `detail-${i}`),
			"[INPUT-BOX]",
		];
		await h.frame(expanded, true);

		const viewport = h.terminal.getViewport();
		assert.ok(viewport[9]!.includes("[INPUT-BOX]"), "input box must sit on the bottom row");
		for (const marker of ["detail-12", "detail-19"]) {
			assert.strictEqual(
				countInBuffer(viewport, marker),
				1,
				`"${marker}" must appear exactly once in the viewport`,
			);
		}

		h.stop();
	});
});
