import assert from "node:assert";
import { describe, it } from "node:test";
import {
	getAmbiguousWidthMode,
	setAmbiguousWidthMode,
	visibleWidth,
} from "../src/utils.ts";

describe("ambiguous width mode (upstream #3302)", () => {
	it("defaults to narrow", () => {
		setAmbiguousWidthMode("narrow");
		assert.strictEqual(getAmbiguousWidthMode(), "narrow");
		assert.strictEqual(visibleWidth("①"), 1);
	});

	it("treats East Asian Ambiguous chars as 2 cells in wide mode", () => {
		setAmbiguousWidthMode("wide");
		try {
			// ① circled digit, ★ star, → arrow, α greek — all Ambiguous class
			assert.strictEqual(visibleWidth("①"), 2);
			assert.strictEqual(visibleWidth("★"), 2);
			assert.strictEqual(visibleWidth("→"), 2);
			assert.strictEqual(visibleWidth("α"), 2);
			// CJK ideographs were always wide; unaffected by the mode
			assert.strictEqual(visibleWidth("汉"), 2);
			// plain ASCII stays 1
			assert.strictEqual(visibleWidth("a"), 1);
		} finally {
			setAmbiguousWidthMode("narrow");
		}
	});

	it("padded columns align when mixing circled digits and CJK in wide mode", () => {
		setAmbiguousWidthMode("wide");
		try {
			// The regression shape from #3302: a line whose ambiguous glyphs were
			// undercounted by 1 cell each wrapped/overlapped its neighbor.
			const a = "①测试";
			const b = "1.测试";
			assert.strictEqual(visibleWidth(a), visibleWidth("1.") + visibleWidth("测试"));
			assert.strictEqual(visibleWidth(b), visibleWidth("1.") + visibleWidth("测试"));
			// The user's regression probe: ①测试 ★测试 →测试 α测试 — every token
			// must sum to its true cell count so no padding overlap can occur.
			assert.strictEqual(visibleWidth("★测试 →测试 α测试"), 2 + 4 + 1 + 2 + 4 + 1 + 2 + 4);
		} finally {
			setAmbiguousWidthMode("narrow");
		}
	});
});
