import { RENDER_LINES, renderComponentLines, textRenderLine, type TuiRenderLine } from "../render-line.ts";
import { allocateStackSizes, Stack, type StackChild, type StackOptions, visibleStackEntries } from "./stack.ts";

export class VStack extends Stack {
	protected readonly layoutType = "vstack" as const;

	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super(children, options);
	}

	override [RENDER_LINES](width: number): TuiRenderLine[] {
		const viewport = { width: Math.max(1, width), height: Number.MAX_SAFE_INTEGER };
		const entries = visibleStackEntries(this.entries, viewport);
		const rendered = entries.map((entry) => renderComponentLines(entry.component, viewport.width));
		const sizes = allocateStackSizes(
			entries,
			rendered.map((lines) => lines.length),
			undefined,
			this.gap,
		);
		const lines: TuiRenderLine[] = [];
		for (let index = 0; index < entries.length; index++) {
			if (index > 0) {
				for (let gap = 0; gap < this.gap; gap++) lines.push(textRenderLine(""));
			}
			const childLines = rendered[index]!.slice(0, sizes[index]);
			lines.push(...childLines);
			for (let padding = childLines.length; padding < sizes[index]!; padding++) lines.push(textRenderLine(""));
		}
		return lines;
	}
}

export type { StackChild, StackEntry, StackEntryOptions, StackOptions } from "./stack.ts";
