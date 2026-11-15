import type { Component } from '@moonshot-ai/pi-tui';

import type { GutterLayout } from '#/tui/components/chrome/gutter-container';
import {
  firstContentLineIndex,
  userMessageLineHeights,
} from '#/tui/components/messages/user-message';
import { getTranscriptComponentEntry } from '#/tui/utils/transcript-component-metadata';

export interface StickyUserMessageJudgment {
  component: Component;
  summary: string;
  targetY: number;
}

interface UserText {
  content: string;
  offset: number;
  lines: string[];
}

interface UserAnchor {
  component: Component;
  firstContentRow: number;
  text: UserText;
  bullet?: string;
}

interface MeasuredUser {
  component: Component;
  text: UserText;
  bullet: string | undefined;
  width: number;
  lineEnds: number[];
  summaryLineCount: number;
  summary: string;
}

export class StickyUserMessageIndex {
  private layout: GutterLayout | undefined;
  private anchors: UserAnchor[] = [];
  private readonly texts = new WeakMap<Component, UserText>();
  private measured: MeasuredUser | undefined;

  getJudgment(
    layout: GutterLayout,
    scrollTop: number,
    following: boolean,
  ): StickyUserMessageJudgment | null {
    if (this.layout !== layout) this.updateLayout(layout);
    // Header height + content padding is always one row. Use body coordinates
    // so the pin threshold does not depend on whether the pill was visible.
    const top = scrollTop - 1;
    let anchor: UserAnchor | undefined;
    if (following) {
      anchor = this.anchors.at(-1);
      if (!anchor || anchor.firstContentRow >= top) return null;
    } else {
      let low = 0;
      let high = this.anchors.length;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (this.anchors[middle]!.firstContentRow < top) low = middle + 1;
        else high = middle;
      }
      // Let the actual message occupy the top row, including search highlights.
      if (this.anchors[low]?.firstContentRow === top) return null;
      anchor = this.anchors[low - 1];
      if (!anchor) return null;
    }

    let measured = this.measured;
    if (
      !measured ||
      measured.component !== anchor.component ||
      measured.text !== anchor.text ||
      measured.bullet !== anchor.bullet ||
      measured.width !== layout.contentWidth
    ) {
      let rows = 0;
      measured = {
        component: anchor.component,
        text: anchor.text,
        bullet: anchor.bullet,
        width: layout.contentWidth,
        lineEnds: userMessageLineHeights(
          anchor.text.content,
          layout.contentWidth,
          anchor.bullet,
        ).map((height) => {
          rows += Math.max(1, height);
          return rows;
        }),
        summaryLineCount: 0,
        summary: '',
      };
      this.measured = measured;
    }

    const rowsOut = scrollTop - anchor.firstContentRow;
    let low = 0;
    let high = measured.lineEnds.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (measured.lineEnds[middle]! <= rowsOut) low = middle + 1;
      else high = middle;
    }
    const lineCount = Math.max(1, low);
    if (lineCount !== measured.summaryLineCount) {
      measured.summary = anchor.text.lines
        .slice(0, lineCount)
        .join(' ')
        .replaceAll(/\s+/g, ' ')
        .trim();
      measured.summaryLineCount = lineCount;
    }
    return {
      component: anchor.component,
      summary: measured.summary,
      targetY: anchor.firstContentRow + 1,
    };
  }

  private updateLayout(layout: GutterLayout): void {
    this.layout = layout;
    this.anchors = [];
    let y = 0;
    for (const { component, height } of layout.children) {
      const entryY = y;
      y += height;
      const entry = getTranscriptComponentEntry(component);
      if (height === 0 || entry?.kind !== 'user' || entry.bullet === '') continue;
      let text = this.texts.get(component);
      if (!text || text.content !== entry.content) {
        const lines = entry.content.split(/\r?\n/);
        const first = firstContentLineIndex(lines);
        text = { content: entry.content, offset: 1 + first, lines: lines.slice(first) };
        this.texts.set(component, text);
      }
      if (text.lines.length === 0) continue;
      this.anchors.push({
        component,
        firstContentRow: entryY + Math.min(text.offset, height),
        text,
        bullet: entry.bullet,
      });
    }
  }
}
