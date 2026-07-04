import assert from "node:assert";
import { describe, it } from "node:test";
import { countInBuffer, createHarness } from "./harness.ts";

// Case 07 — rows vanish and content creeps upward while streaming.
//
// Symptom: during a long streaming turn, visible transcript rows kept
// disappearing and the remaining content crept upward, leaving an
// ever-growing blank area under the input box. Scrolling back showed
// gaps: the vanished rows were in neither the screen nor scrollback.
//
// Root cause: the viewport anchor pins a *buffer row index*, not
// content. When content ABOVE the viewport shrinks by k lines (a
// finished agent-group row collapsing, a merged step, a spinner line
// disappearing), every line below the shrink point shifts up by k, so
// the pinned window suddenly shows content k lines further down: the
// screen appears to jump up, and the k rows that slid above the window
// top are lost — scrollback at those indices holds older bytes, and the
// rows were never committed. Each above-viewport net shrink permanently
// swallows k rows.
//
// The fix makes the anchor follow content instead of row indices: when
// the frame is best explained as an above-viewport shift, the anchor
// moves with the shift (screen content stays put), and later growth
// commits rows in content order — no loss, no duplication.
//
// Fixed: the anchor follows the shift, so the screen stays put and later
// growth commits rows in content order.

describe("e2e case07: above-viewport shrink must not shift or lose rows", () => {
	it("keeps the visible window unchanged when lines above it are removed", async () => {
		// 60 lines at height 10 -> anchor 50; screen shows row-50..row-58 + input.
		const initial = [...Array.from({ length: 59 }, (_, i) => `row-${i}`), "[INPUT-BOX]"];
		const h = await createHarness(initial, { rows: 10 });
		const before = h.terminal.getViewport();
		assert.ok(before[0]!.includes("row-50"), "sanity: window starts at row-50");

		// Remove 3 lines far above the viewport (row-10..row-12); everything
		// below shifts up by 3, but the visible content is unchanged.
		const shrunk = initial.filter((_, i) => i < 10 || i > 12);
		await h.frame(shrunk);

		assert.deepStrictEqual(
			h.terminal.getViewport(),
			before,
			"the visible window must not move when only above-viewport lines are removed",
		);

		// Growth afterwards must commit rows in content order: nothing lost,
		// nothing duplicated.
		const grown = [...shrunk.slice(0, -1), "tail-0", "tail-1", "tail-2", "[INPUT-BOX]"];
		await h.frame(grown);

		const buffer = h.terminal.getScrollBuffer();
		for (const marker of ["row-49", "row-50", "row-51", "row-52", "row-53"]) {
			const count = countInBuffer(buffer, marker);
			assert.strictEqual(count, 1, `"${marker}" must appear exactly once, got ${count}`);
		}
		const viewport = h.terminal.getViewport();
		assert.ok(viewport.some((line) => line.includes("tail-2")), "appended rows must be visible");
		assert.ok(viewport[9]!.includes("[INPUT-BOX]"), "input box must sit on the bottom row");

		h.stop();
	});

	it("applies the shift even when a live row inside the window also changed", async () => {
		// Same shape, but the window contains a status line that changes in
		// the same frame as the above-viewport shrink (spinner/timer tick).
		const content = (status: string): string[] => [
			...Array.from({ length: 58 }, (_, i) => `row-${i}`),
			status,
			"[INPUT-BOX]",
		];
		const h = await createHarness(content("status-A"), { rows: 10 });
		const before = h.terminal.getViewport();
		assert.ok(before.some((line) => line.includes("status-A")), "sanity: status visible");

		// Remove 3 above-viewport lines AND tick the status line.
		const shrunk = content("status-B").filter((_, i) => i < 10 || i > 12);
		await h.frame(shrunk);

		const after = h.terminal.getViewport();
		assert.ok(after.some((line) => line.includes("status-B")), "status line must show the new value");
		// Every other visible row stays put (no upward creep).
		for (let r = 0; r < 10; r++) {
			if (before[r]!.includes("status-A")) continue;
			assert.strictEqual(
				after[r],
				before[r],
				`row ${r} must not move on an above-viewport shrink`,
			);
		}

		h.stop();
	});
});
