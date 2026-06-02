import type { Component } from '@earendil-works/pi-tui';

import { AssistantMessageComponent } from '../components/messages/assistant-message';
import { UndoHighlightComponent } from '../components/messages/undo-highlight';
import {
  commitUndoCommand,
  isUndoAnchorComponent,
  isUndoBoundaryComponent,
  isUndoContextComponent,
} from '../commands/undo';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import type { SlashCommandHost } from '../commands/dispatch';
import type { TUIState } from '../tui-state';
import type { TranscriptEntry } from '../types';
import { getTranscriptComponentEntry } from '../utils/transcript-component-metadata';

export interface UndoPreviewHost extends SlashCommandHost {
  state: TUIState;
  updateEditorBorderHighlight(text?: string): void;
}

interface UndoPreviewState {
  readonly originalChildren: readonly Component[];
  readonly anchorIndices: readonly number[];
  selectedCount: number;
}

export class UndoPreviewController {
  private preview: UndoPreviewState | null = null;

  constructor(private readonly host: UndoPreviewHost) {}

  isActive(): boolean {
    return this.preview !== null;
  }

  start(count: number): void {
    if (this.host.state.appState.streamingPhase !== 'idle') {
      this.host.showError('Cannot undo while streaming — press Esc or Ctrl-C first.');
      return;
    }
    if (this.host.session === undefined) {
      this.host.showError(NO_ACTIVE_SESSION_MESSAGE);
      return;
    }

    this.cancel();

    const originalChildren = [...this.host.state.transcriptContainer.children];
    const range = undoPreviewRange(originalChildren);
    const { anchorIndices } = range;
    if (anchorIndices.length === 0) {
      this.host.showError('Nothing to undo.');
      return;
    }
    if (count > anchorIndices.length) {
      this.host.showError(
        range.hasBoundary
          ? 'Cannot undo past the most recent compaction boundary.'
          : 'Cannot undo that many prompts.',
      );
      return;
    }

    this.preview = {
      originalChildren,
      anchorIndices,
      selectedCount: count,
    };
    this.apply();
  }

  moveUp(): boolean {
    const preview = this.preview;
    if (preview === null || preview.selectedCount >= preview.anchorIndices.length) return false;
    preview.selectedCount += 1;
    this.apply();
    return true;
  }

  moveDown(): boolean {
    const preview = this.preview;
    if (preview === null || preview.selectedCount <= 1) return false;
    preview.selectedCount -= 1;
    this.apply();
    return true;
  }

  cancel(): boolean {
    const preview = this.preview;
    if (preview === null) return false;
    this.restore(preview.originalChildren);
    this.preview = null;
    return true;
  }

  async commit(): Promise<void> {
    const preview = this.preview;
    if (preview === null) return;
    const count = preview.selectedCount;
    const selectedInput = selectedUndoInput(preview);
    this.restore(preview.originalChildren);
    this.preview = null;
    const committed = await commitUndoCommand(this.host, count);
    if (committed && selectedInput !== undefined) {
      this.host.state.editor.setText(selectedInput);
      this.host.updateEditorBorderHighlight(selectedInput);
      this.host.state.ui.requestRender();
    }
  }

  private apply(): void {
    const preview = this.preview;
    if (preview === null) return;

    const selectedIndex = preview.anchorIndices[
      preview.anchorIndices.length - preview.selectedCount
    ];
    if (selectedIndex === undefined) return;
    const nextAnchorIndex = preview.anchorIndices.find((index) => index > selectedIndex);
    const selectedEndIndex = nextAnchorIndex ?? preview.originalChildren.length;
    const selectedAnchor = preview.originalChildren[selectedIndex];
    if (selectedAnchor === undefined) return;
    const selectedBodyChildren = selectedPreviewBodyChildren(
      preview.originalChildren.slice(selectedIndex + 1, selectedEndIndex),
    );

    const nextChildren: Component[] = [];
    for (let index = 0; index < preview.originalChildren.length; index++) {
      const child = preview.originalChildren[index];
      if (child === undefined) continue;
      if (index < selectedIndex) {
        nextChildren.push(child);
        continue;
      }
      if (index === selectedIndex) {
        nextChildren.push(
          new UndoHighlightComponent(selectedAnchor, this.host.state.theme.colors, {
            extendBottom: selectedBodyChildren.length === 0,
          }),
        );
        if (selectedBodyChildren.length > 0) {
          nextChildren.push(
            new UndoHighlightComponent(selectedBodyChildren, this.host.state.theme.colors, {
              extendBottom: true,
              maxLines: hasAssistantOutput(selectedBodyChildren) ? undefined : 5,
            }),
          );
        }
        continue;
      }
      if (index < selectedEndIndex) {
        continue;
      }
      if (!isUndoContextComponent(child)) {
        nextChildren.push(child);
      }
    }

    this.replaceChildren(nextChildren);
  }

  private restore(children: readonly Component[]): void {
    this.replaceChildren(children);
  }

  private replaceChildren(children: readonly Component[]): void {
    const current = this.host.state.transcriptContainer.children;
    current.splice(0, current.length, ...children);
    this.host.state.transcriptContainer.invalidate();
    this.host.state.ui.requestRender();
  }
}

function undoPreviewRange(children: readonly Component[]): {
  readonly anchorIndices: readonly number[];
  readonly hasBoundary: boolean;
} {
  let boundaryIndex = -1;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child !== undefined && isUndoBoundaryComponent(child)) {
      boundaryIndex = i;
      break;
    }
  }

  const indices: number[] = [];
  for (let i = boundaryIndex + 1; i < children.length; i++) {
    const child = children[i];
    if (child !== undefined && isUndoAnchorComponent(child)) {
      indices.push(i);
    }
  }
  return { anchorIndices: indices, hasBoundary: boundaryIndex >= 0 };
}

function selectedPreviewBodyChildren(children: readonly Component[]): readonly Component[] {
  const undoContextChildren = children.filter((child) => isUndoContextComponent(child));
  const assistantChildren = undoContextChildren.filter((child) => isAssistantOutputComponent(child));
  return assistantChildren.length > 0 ? assistantChildren : undoContextChildren;
}

function hasAssistantOutput(children: readonly Component[]): boolean {
  return children.some((child) => isAssistantOutputComponent(child));
}

function isAssistantOutputComponent(child: Component): boolean {
  const entry = getTranscriptComponentEntry(child);
  if (entry !== undefined) {
    return entry.kind === 'assistant' && entry.content.trim().length > 0;
  }
  return child instanceof AssistantMessageComponent;
}

function selectedUndoInput(preview: UndoPreviewState): string | undefined {
  const selectedIndex = preview.anchorIndices[
    preview.anchorIndices.length - preview.selectedCount
  ];
  const child = selectedIndex === undefined ? undefined : preview.originalChildren[selectedIndex];
  if (child === undefined) return undefined;
  return undoInputForEntry(getTranscriptComponentEntry(child));
}

function undoInputForEntry(entry: TranscriptEntry | undefined): string | undefined {
  if (entry?.kind === 'user') return entry.content;
  if (entry?.kind !== 'skill_activation' || entry.skillTrigger !== 'user-slash') {
    return undefined;
  }
  const skillName = entry.skillName?.trim();
  if (skillName === undefined || skillName.length === 0) return undefined;
  const args = entry.skillArgs?.trim();
  return args === undefined || args.length === 0
    ? `/skill:${skillName}`
    : `/skill:${skillName} ${args}`;
}
