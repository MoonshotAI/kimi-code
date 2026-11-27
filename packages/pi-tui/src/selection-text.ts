import { visibleWidth } from "./utils.ts";

export type SelectionAffinity = "forward" | "backward";

export interface SelectionTextSpan {
	start: number;
	end: number;
	cellStart: number;
	cellEnd: number;
}

export function getSelectionTextSpans(
	text: string,
	segments: Iterable<Intl.SegmentData>,
): SelectionTextSpan[] {
	const spans: SelectionTextSpan[] = [];
	let cellStart = 0;
	for (const grapheme of segments) {
		const cellEnd = cellStart + visibleWidth(grapheme.segment);
		spans.push({
			start: grapheme.index,
			end: grapheme.index + grapheme.segment.length,
			cellStart,
			cellEnd,
		});
		cellStart = cellEnd;
	}
	if (spans.length === 0 && text.length > 0) {
		return [{ start: 0, end: text.length, cellStart: 0, cellEnd: visibleWidth(text) }];
	}
	return spans;
}

export function getSelectionOffsetsAtColumn(
	spans: SelectionTextSpan[],
	column: number,
): { start: number; end: number } {
	const first = spans[0];
	if (!first || column <= 0) return { start: 0, end: 0 };
	for (const span of spans) {
		if (column < span.cellEnd) return { start: span.start, end: span.end };
	}
	const last = spans[spans.length - 1]!;
	return { start: last.end, end: last.end };
}

export function getSelectionColumnAtOffset(
	spans: SelectionTextSpan[],
	offset: number,
	affinity: SelectionAffinity,
): number {
	const last = spans[spans.length - 1];
	if (!last) return 0;
	const selectedOffset = Math.max(0, Math.min(offset, last.end));
	for (const span of spans) {
		if (selectedOffset === span.start) return span.cellStart;
		if (selectedOffset > span.start && selectedOffset < span.end) {
			return affinity === "forward" ? span.cellEnd : span.cellStart;
		}
	}
	return last.cellEnd;
}
