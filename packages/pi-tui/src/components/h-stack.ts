import {
	RENDER_LINES,
	renderComponentLines,
	textRenderLine,
	type TuiRenderLine,
	withSelectionJoinBarrier,
} from "../render-line.ts";
import { compositeTuiRenderLine } from "../tui.ts";
import { visibleWidth } from "../utils.ts";
import { allocateStackSizes, Stack, type StackChild, type StackOptions, visibleStackEntries } from "./stack.ts";

export class HStack extends Stack {
	protected readonly layoutType = "hstack" as const;

	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super(children, options);
	}

	override [RENDER_LINES](width: number): TuiRenderLine[] {
		const safeWidth = Math.max(1, width);
		const viewport = { width: safeWidth, height: Number.MAX_SAFE_INTEGER };
		const entries = visibleStackEntries(this.entries, viewport);
		if (entries.length === 0) return [];

		const intrinsicWidths = entries.map((entry) => {
			const lines = renderComponentLines(entry.component, safeWidth);
			return lines.reduce((max, line) => Math.max(max, visibleWidth(line.text)), 0);
		});
		const widths = allocateStackSizes(entries, intrinsicWidths, safeWidth, this.gap);
		const rendered = entries.map((entry, index) =>
			widths[index] === 0 ? [] : renderComponentLines(entry.component, widths[index]!),
		);
		const height = rendered.reduce((max, lines) => Math.max(max, lines.length), 0);
		const result = Array.from({ length: height }, () => textRenderLine(""));
		let x = 0;
		for (let index = 0; index < rendered.length; index++) {
			const lines = rendered[index]!;
			const childWidth = widths[index]!;
			let offset = 0;
			if (this.align === "center") offset = Math.floor((height - lines.length) / 2);
			else if (this.align === "end") offset = height - lines.length;
			for (let row = 0; row < lines.length; row++) {
				const target = row + offset;
				if (target < 0 || target >= result.length) continue;
				result[target] = compositeTuiRenderLine(result[target]!, lines[row]!, x, childWidth, safeWidth);
			}
			x += childWidth + this.gap;
		}
		return entries.length === 1 ? result : result.map(withSelectionJoinBarrier);
	}
}
