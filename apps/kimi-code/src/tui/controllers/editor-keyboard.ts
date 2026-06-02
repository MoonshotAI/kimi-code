import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { ClipboardMediaError, readClipboardMedia } from '#/utils/clipboard/clipboard-image';
import { parseImageMeta } from '#/utils/image/image-mime';
import { editInExternalEditor, resolveEditorCommand } from '#/utils/process/external-editor';

import {
  CTRL_C_HINT,
  CTRL_D_HINT,
  EXIT_CONFIRM_WINDOW_MS,
  LLM_NOT_SET_MESSAGE,
  NO_ACTIVE_SESSION_MESSAGE,
} from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { ImageAttachmentStore } from '../utils/image-attachment-store';
import type { PendingExit } from '../types';
import type { TUIState } from '../tui-state';

export interface EditorKeyboardHost {
  state: TUIState;
  session: Session | undefined;
  cancelInFlight: (() => void) | undefined;

  handleUserInput(text: string): void;
  isUndoPreviewActive(): boolean;
  moveUndoPreviewUp(): boolean;
  moveUndoPreviewDown(): boolean;
  commitUndoPreview(): void;
  cancelUndoPreview(): boolean;
  steerMessage(session: Session, input: string[]): void;
  recallLastQueued(): string | undefined;
  showError(msg: string): void;
  track(event: string, props?: Record<string, unknown>): void;
  updateEditorBorderHighlight(text?: string): void;
  updateQueueDisplay(): void;
  toggleToolOutputExpansion(): void;
  togglePlanExpansion(): boolean;
  hideSessionPicker(): void;
  stop(exitCode?: number): Promise<void>;
  handlePlanToggle(next: boolean): void;
  clearQueuedMessages(): void;
  setExternalEditorRunning(running: boolean): void;
}

export class EditorKeyboardController {
  private pendingExit: PendingExit | null = null;

  constructor(
    private readonly host: EditorKeyboardHost,
    private readonly imageStore: ImageAttachmentStore,
  ) {}

  install(): void {
    const { host } = this;
    const editor = host.state.editor;

    editor.onSubmit = (text: string) => {
      if (host.isUndoPreviewActive() && text.trim().length === 0) {
        host.commitUndoPreview();
        return;
      }
      if (host.isUndoPreviewActive()) host.cancelUndoPreview();
      host.handleUserInput(text);
    };

    editor.onChange = (text: string) => {
      if (this.pendingExit) this.clearPendingExit();
      if (host.isUndoPreviewActive() && text.length > 0) {
        host.cancelUndoPreview();
      }
      host.updateEditorBorderHighlight(text);
    };

    editor.onCtrlC = () => {
      if (host.isUndoPreviewActive()) {
        this.clearPendingExit();
        host.cancelUndoPreview();
        return;
      }

      if (host.cancelInFlight !== undefined) {
        const cancel = host.cancelInFlight;
        host.cancelInFlight = undefined;
        this.clearPendingExit();
        cancel();
        return;
      }

      if (host.state.appState.isCompacting) {
        this.clearPendingExit();
        this.cancelCurrentCompaction();
        return;
      }

      if (host.state.appState.streamingPhase !== 'idle') {
        this.clearPendingExit();
        this.cancelCurrentStream();
        return;
      }

      if (this.pendingExit?.kind === 'ctrl-c') {
        this.clearPendingExit();
        void host.stop();
        return;
      }

      if (editor.getText().length > 0) {
        editor.setText('');
      }
      this.armPendingExit('ctrl-c', CTRL_C_HINT);
    };

    editor.onCtrlD = () => {
      if (host.isUndoPreviewActive()) {
        this.clearPendingExit();
        host.cancelUndoPreview();
        return;
      }

      if (this.pendingExit?.kind === 'ctrl-d') {
        this.clearPendingExit();
        void host.stop();
        return;
      }
      this.armPendingExit('ctrl-d', CTRL_D_HINT);
    };

    editor.onEscape = () => {
      if (this.pendingExit) this.clearPendingExit();
      if (host.isUndoPreviewActive()) {
        host.cancelUndoPreview();
        return;
      }
      if (host.state.activeDialog === 'session-picker') {
        host.hideSessionPicker();
        return;
      }
      if (host.state.appState.isCompacting) {
        this.cancelCurrentCompaction();
        return;
      }
      if (host.state.appState.streamingPhase !== 'idle') {
        this.cancelCurrentStream();
      }
    };

    editor.onShiftTab = () => {
      if (host.session === undefined) {
        host.showError(NO_ACTIVE_SESSION_MESSAGE);
        return;
      }
      const next = !host.state.appState.planMode;
      host.track('shortcut_plan_toggle', { enabled: next });
      host.track('shortcut_mode_switch', { to_mode: next ? 'plan' : 'agent' });
      host.handlePlanToggle(next);
    };

    editor.onOpenExternalEditor = () => {
      host.track('shortcut_editor');
      void this.openExternalEditor();
    };

    editor.onToggleToolExpand = () => {
      host.track('shortcut_expand');
      host.toggleToolOutputExpansion();
    };

    editor.onTogglePlanExpand = () => host.togglePlanExpansion();

    editor.onCtrlS = () => {
      if (host.state.appState.streamingPhase === 'idle' || host.state.appState.isCompacting) return;
      const text = editor.getText().trim();
      const queuedTexts = host.state.queuedMessages.map((m) => m.text);
      host.clearQueuedMessages();

      const parts: string[] = [];
      for (const q of queuedTexts) {
        const trimmed = q.trim();
        if (trimmed.length > 0) parts.push(trimmed);
      }
      if (text.length > 0) parts.push(text);

      if (parts.length > 0) {
        editor.setText('');
        const session = host.session;
        if (host.state.appState.model.trim().length === 0 || session === undefined) {
          host.showError(LLM_NOT_SET_MESSAGE);
        } else {
          host.steerMessage(session, parts);
        }
      }
      host.updateQueueDisplay();
      host.state.ui.requestRender();
    };

    editor.onUndo = () => {
      host.track('undo');
    };

    editor.onInsertNewline = () => {
      host.track('shortcut_newline');
    };

    editor.onTextPaste = () => {
      host.track('shortcut_paste', { kind: 'text' });
    };

    editor.onUpArrowEmpty = () => {
      if (host.isUndoPreviewActive()) {
        host.moveUndoPreviewUp();
        return true;
      }
      if (host.state.appState.streamingPhase === 'idle' && !host.state.appState.isCompacting) return false;
      const recalled = host.recallLastQueued();
      if (recalled !== undefined) {
        editor.setText(recalled);
        host.updateQueueDisplay();
        host.state.ui.requestRender();
        return true;
      }
      return false;
    };

    editor.onDownArrowEmpty = () => {
      if (!host.isUndoPreviewActive()) return false;
      host.moveUndoPreviewDown();
      return true;
    };

    editor.onPasteImage = async () => this.handleClipboardImagePaste();
  }

  clearPendingExit(): void {
    if (!this.pendingExit) return;
    clearTimeout(this.pendingExit.timer);
    this.host.state.footer.setTransientHint(null);
    this.pendingExit = null;
  }

  private armPendingExit(kind: 'ctrl-c' | 'ctrl-d', hint: string): void {
    this.clearPendingExit();
    this.host.state.footer.setTransientHint(hint);

    const timer = setTimeout(() => {
      if (this.pendingExit?.timer === timer) {
        this.clearPendingExit();
        this.host.state.ui.requestRender();
      }
    }, EXIT_CONFIRM_WINDOW_MS);

    this.pendingExit = { kind, timer };
    this.host.state.ui.requestRender();
  }

  private cancelCurrentStream(): void {
    void this.host.session?.cancel();
  }

  private cancelCurrentCompaction(): void {
    const session = this.host.session;
    if (session === undefined) return;
    void session.cancelCompaction().catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.host.showError(`Failed to cancel compaction: ${message}`);
    });
  }

  private async handleClipboardImagePaste(): Promise<boolean> {
    let media;
    try {
      media = await readClipboardMedia();
    } catch (error) {
      if (error instanceof ClipboardMediaError) {
        this.host.showError(error.message);
        return true;
      }
      return false;
    }
    if (media === null) return false;

    if (media.kind === 'video') {
      const attachment = this.imageStore.addVideo(media.mimeType, media.sourcePath, media.filename);
      this.host.state.editor.insertTextAtCursor?.(`${attachment.placeholder} `);
      this.host.state.ui.requestRender();
      this.host.track('shortcut_paste', { kind: 'video' });
      return true;
    }

    const meta = parseImageMeta(media.bytes);
    if (meta === null) return false;
    const attachment = this.imageStore.addImage(media.bytes, meta.mime, meta.width, meta.height);
    this.host.state.editor.insertTextAtCursor?.(`${attachment.placeholder} `);
    this.host.state.ui.requestRender();
    this.host.track('shortcut_paste', { kind: 'image' });
    return true;
  }

  private async openExternalEditor(): Promise<void> {
    const { state } = this.host;
    if (state.externalEditorRunning) return;
    const cmd = resolveEditorCommand(state.appState.editorCommand);
    if (cmd === undefined) {
      this.host.showError('No editor configured. Set $VISUAL / $EDITOR, or run /editor <command>.');
      return;
    }
    this.host.setExternalEditorRunning(true);
    const seed = state.editor.getExpandedText?.() ?? state.editor.getText();
    state.ui.stop();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    try {
      const result = await editInExternalEditor(seed, cmd);
      if (result !== undefined) {
        state.editor.setText(result.replaceAll('\r\n', '\n').replace(/\n$/, ''));
      }
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.host.showError(`External editor failed: ${msg}`);
    } finally {
      if (typeof process.stdin.pause === 'function') {
        process.stdin.pause();
      }
      state.ui.start();
      state.ui.setFocus(state.editor);
      state.ui.requestRender(true);
      this.host.setExternalEditorRunning(false);
    }
  }
}
