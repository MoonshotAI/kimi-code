import assert from "node:assert";
import { describe, it } from "node:test";
import { createHarness } from "./harness.ts";

// Case 05 — transcript rows missing from scrollback after streaming.
//
// Symptom: after long streaming turns, scrolling up showed gaps: spans of
// transcript rows were simply absent from scrollback.
//
// Root cause (invariant 2, exactly-once commit): when a single frame both
// changed a line above the viewport (status/reflow) and grew the content
// past the pinned anchor, the length-change branch advanced the anchor and
// repainted the screen in place without scrolling. The rows between the
// old and new anchor were overwritten on screen and never committed to
// scrollback. Found by review on #1353.
//
// Fixed on #1353: an anchor advance now paints from the old anchor and
// scrolls the skipped rows into scrollback, committing each exactly once.

describe("e2e case05: growth past the anchor must not lose rows", () => {
	it("commits the rows skipped by an anchor advance exactly once", async () => {
		// 60 lines at height 10 -> anchor 50; rows 50..59 are on screen and
		// not yet committed to scrollback.
		const h = await createHarness([...Array.from({ length: 59 }, (_, i) => `row-${i}`), "[INPUT-BOX]"], {
			rows: 10,
		});

		// One frame combines an above-viewport change (row-10 completes)
		// with growth past the anchor (3 appended rows): anchor 50 -> 53.
		const grown = [
			...Array.from({ length: 59 }, (_, i) => (i === 10 ? "row-10 [done]" : `row-${i}`)),
			"tail-0",
			"tail-1",
			"tail-2",
			"[INPUT-BOX]",
		];
		await h.frame(grown);

		// The rows the anchor skipped over must be in the buffer exactly
		// once — they crossed the viewport top and have to be committed.
		const buffer = h.terminal.getScrollBuffer();
		for (const marker of ["row-50", "row-51", "row-52"]) {
			const count = buffer.filter((line) => line.includes(marker)).length;
			assert.strictEqual(count, 1, `"${marker}" must survive the anchor advance, got ${count} occurrences`);
		}

		// And the fresh tail is visible with the input box at the bottom.
		const viewport = h.terminal.getViewport();
		assert.ok(viewport.some((line) => line.includes("tail-2")), "appended rows must be visible");
		assert.ok(viewport[9]!.includes("[INPUT-BOX]"), "input box must sit on the bottom row");

		h.stop();
	});
});
