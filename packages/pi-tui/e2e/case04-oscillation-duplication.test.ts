import assert from "node:assert";
import { describe, it } from "node:test";
import { assertExactlyOnce, createHarness } from "./harness.ts";

// Case 04 — transcript spans duplicated in scrollback during streaming.
//
// Symptom: while an agent streamed output, scrolling up showed the same
// span of transcript (activity lines, messages) repeated over and over;
// each shrink/grow oscillation of the live region stacked another copy.
//
// Root cause: a partial shrink re-anchored (rewound) previousViewportTop,
// repainting rows scrollback already held; the next growth scrolled them
// out again. Fixed in #1353: the anchor never rewinds on a partial shrink
// (it stays pinned; growth refills the gap), so every row is committed to
// scrollback exactly once.

describe("e2e case04: shrink/grow oscillation must not duplicate scrollback", () => {
	const transcript = (status: string, activity: string[]): string[] => [
		...Array.from({ length: 30 }, (_, i) => `msg-${i}`),
		status,
		...Array.from({ length: 25 }, (_, i) => `out-${i}`),
		...activity,
		"[INPUT-BOX]",
	];
	const fullActivity = ["act-0", "act-1", "act-2", "act-3"];

	it("keeps every row exactly once across repeated oscillations", async () => {
		const h = await createHarness(transcript("status-0", fullActivity), { rows: 10 });

		// Three oscillations: the activity pane collapses and regrows while
		// a status line above the viewport keeps changing (streaming reflow).
		for (let cycle = 1; cycle <= 3; cycle++) {
			await h.frame(transcript(`status-${cycle}a`, []));
			await h.frame(transcript(`status-${cycle}b`, fullActivity));
		}

		// Stable rows must appear exactly once — no duplicated spans, no
		// losses. (Status lines are excluded: they legitimately leave stale
		// copies above the viewport.)
		assertExactlyOnce(h.terminal, ["msg-29", "out-0", "out-13", "out-24", "act-0", "act-3", "[INPUT-BOX]"]);

		const viewport = h.terminal.getViewport();
		assert.ok(viewport[9]!.includes("[INPUT-BOX]"), "input box must be back on the bottom row");

		h.stop();
	});

	it("keeps the pinned gap bounded and refills it on growth", async () => {
		const h = await createHarness(transcript("status-0", fullActivity), { rows: 10 });

		await h.frame(transcript("status-0", []));
		const pinned = h.terminal.getViewport();
		const inputRow = pinned.findIndex((line) => line.includes("[INPUT-BOX]"));
		assert.ok(inputRow >= 0 && inputRow < 9, "input box hovers above a bounded blank gap while pinned");
		assert.strictEqual(pinned[9], "", "rows below the pinned content stay blank");

		await h.frame(transcript("status-0", fullActivity));
		assert.ok(h.terminal.getViewport()[9]!.includes("[INPUT-BOX]"), "growth refills the gap to the bottom row");

		h.stop();
	});
});
