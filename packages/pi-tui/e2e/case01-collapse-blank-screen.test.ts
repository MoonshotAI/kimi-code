import assert from "node:assert";
import { describe, it } from "node:test";
import { createHarness } from "./harness.ts";

// Case 01 — blank screen / missing input box after a large shrink.
//
// Symptom: after context compaction (or any event collapsing the transcript
// far above the viewport top), the screen went mostly blank and the input
// box disappeared; typing produced no visible feedback.
//
// Root cause: the differential path clamped the first changed line to the
// viewport but then rendered as if nothing had shifted, desyncing the
// cursor. Fixed in #1315 by re-anchoring the viewport to the tail of the
// collapsed content (repaintViewport).

describe("e2e case01: collapse must keep the input box on screen", () => {
	it("shows the content tail and input box after a 60 -> 8 line collapse", async () => {
		const h = await createHarness([...Array.from({ length: 59 }, (_, i) => `old-${i}`), "[INPUT-BOX]"], {
			rows: 10,
		});

		// Collapse far above the viewport top (anchor is at 50) with a
		// changed line above it — the original failure combination.
		await h.frame(["new-0", "new-1", "new-2", "new-3", "new-4", "new-5", "new-6", "[INPUT-BOX]"]);

		const viewport = h.terminal.getViewport();
		assert.ok(
			viewport.some((line) => line.includes("[INPUT-BOX]")),
			`input box must stay visible, got: ${JSON.stringify(viewport)}`,
		);
		assert.ok(
			viewport.some((line) => line.includes("new-0")),
			"collapsed content must be visible",
		);

		// Self-healing: the next differential frame must land in place.
		await h.frame(["new-0", "new-1", "new-2", "new-3", "new-4", "new-5", "new-6", "[INPUT-BOX]x"]);
		assert.ok(
			h.terminal.getViewport().some((line) => line.includes("[INPUT-BOX]x")),
			"frame after the collapse must update the input box in place",
		);

		h.stop();
	});

	it("re-anchors to the tail when collapsed content is still taller than the screen", async () => {
		const h = await createHarness([...Array.from({ length: 99 }, (_, i) => `old-${i}`), "[INPUT-BOX]"], {
			rows: 10,
		});

		await h.frame([...Array.from({ length: 29 }, (_, i) => `new-${i}`), "[INPUT-BOX]"]);

		const viewport = h.terminal.getViewport();
		assert.ok(viewport[9]!.includes("[INPUT-BOX]"), `input box must sit on the bottom row, got: ${JSON.stringify(viewport)}`);
		assert.ok(viewport[0]!.includes("new-20"), "viewport must show the tail of the new content");

		h.stop();
	});
});
