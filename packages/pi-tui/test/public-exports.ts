import {
	RENDER_LINES,
	type Component,
	type SoftWrapContinuation,
	type SoftWrapFragment,
	type ScrollViewOptions,
	type TuiRenderLine,
	type TuiSelectionRegion,
	type TuiSelectionTarget,
	withRenderLineSelectionRegion,
} from "@moonshot-ai/pi-tui";

const continuation: SoftWrapContinuation = {
	omittedWhitespace: " ",
	generatedIndent: 2,
};

const fragment: SoftWrapFragment = {
	logicalLineId: 1,
	start: 0,
	end: 4,
	continuation,
};

const selectionRegion: TuiSelectionRegion = {
	content: { text: "text", softWrap: [fragment] },
	column: 2,
	width: 4,
};

const scrollViewOptions: ScrollViewOptions = {
	scrollbar: "auto",
	scrollbarLayout: "dedicated",
};
void scrollViewOptions;

export class PublicApiComponent implements Component {
	render(_width: number): string[] {
		return ["text"];
	}

	[RENDER_LINES](_width: number): TuiRenderLine[] {
		return [
			withRenderLineSelectionRegion(
				{ text: "  text" },
				selectionRegion.content,
				selectionRegion.column,
				selectionRegion.width,
			),
		];
	}

	selectionTargetAt(row: number, column: number): TuiSelectionTarget {
		return { component: this, row, col: column, originX: 0, originY: 0 };
	}

	invalidate(): void {}
}
