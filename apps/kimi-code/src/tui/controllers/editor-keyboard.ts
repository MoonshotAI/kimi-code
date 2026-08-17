import { unlink } from 'node:fs/promises';

import type { FileMeta, KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';
import { compressImageForModel, persistOriginalImage, sessionMediaOriginalsDir } from '@moonshot-ai/kimi-code-sdk';

import { ClipboardMediaError, readClipboardMedia } from '#/utils/clipboard/clipboard-image';
import { parseImageMeta } from '#/utils/image/image-mime';
import { editInExternalEditor, resolveEditorCommand } from '#/utils/process/external-editor';

import {
  CTRL_C_HINT,
  CTRL_D_HINT,
  DOUBLE_ESC_WINDOW_MS,
  EXIT_CONFIRM_WINDOW_MS,
  LLM_NOT_SET_MESSAGE,
  NO_ACTIVE_SESSION_MESSAGE,
} from '../constant/kimi-tui';
import { IMAGE_STAGING_TTL_SECONDS } from '../constant/media';
import { formatErrorMessage } from '../utils/event-payload';
import type { ImageAttachment, ImageAttachmentStore } from '../utils/image-attachment-store';
import { extractMediaAttachments, imageExtensionForMime } from '../utils/image-placeholder';
import { extractInlineSkillActivations } from '../utils/inline-skill-tokens';
import type { PendingExit, QueuedMessage, SteerInputItem } from '../types';
import type { TUIState } from '../tui-state';
import type { BtwPanelController } from './btw-panel';

export interface EditorKeyboardHost {
  state: TUIState;
  session: Session | undefined;
  /**
   * True when the TUI runs on the agent-core-v2 engine (startup-selected).
   * Gates the paste-time upload to the daemon file store; the v1 engine has
   * no file store and keeps the submit-time inline base64 form.
   */
  readonly engineV2: boolean;
  cancelInFlight: (() => void) | undefined;
  /**
   * The host's harness (KimiTUI always has one). Its `imageLimits` drives
   * paste-time image compression; hosts without one fall back to the
   * env/built-in default.
   */
  harness?: KimiHarness | undefined;

  handleUserInput(text: string): void;
  readonly btwPanelController: BtwPanelController;
  readonly skillCommandMap: Map<string, string>;
  steerMessage(session: Session, input: readonly SteerInputItem[]): void;
  steerSkillActivation(session: Session, skillName: string, skillArgs: string): void;
  validateMediaCapabilities(extraction: {
    hasMedia: boolean;
    imageAttachmentIds: readonly number[];
    videoAttachmentIds: readonly number[];
  }): boolean;
  releaseStagingMedia(imageAttachmentIds: readonly number[], paths: readonly string[]): void;
  recallLastQueued(): QueuedMessage | undefined;
  showError(msg: string): void;
  track(event: string, props?: Record<string, unknown>): void;
  updateEditorBorderHighlight(text?: string): void;
  /** `undefined` means the input cannot be a `/goal` command (clear without measuring). */
  updateGoalLengthWarning(text: string | undefined): void;
  updateQueueDisplay(): void;
  toggleToolOutputExpansion(): void;
  toggleTodoPanelExpansion(): void;
  detachCurrentForegroundTask(): void;
  cancelRunningShellCommand(): void;
  hideSessionPicker(): void;
  openUndoSelector(): void;
  stop(exitCode?: number): Promise<void>;
  ensureSession(): Promise<Session | undefined>;
  handlePlanToggle(next: boolean): void;
  handleInputModeChange(mode: 'prompt' | 'bash'): void;
  clearQueuedMessages(): void;
  setExternalEditorRunning(running: boolean): void;
  updateActivityPane(): void;
}

export class EditorKeyboardController {
  private pendingExit: PendingExit | null = null;
  private pendingUndoEsc: { readonly timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(
    private readonly host: EditorKeyboardHost,
    private readonly imageStore: ImageAttachmentStore,
  ) {}

  install(): void {
    const { host } = this;
    const editor = host.state.editor;

    editor.onSubmit = (text: string) => {
      host.handleUserInput(text);
    };

    editor.onChange = (text: string) => {
      if (this.pendingExit) this.clearPendingExit();
      host.updateEditorBorderHighlight(text);
      // Expanding paste markers costs a full-text pass, and only `/goal`
      // input can trip the objective length limit — so skip the expansion
      // for ordinary prompts. Submitted text is trimmed before dispatch, so
      // gate on the trimmed text too. A paste marker may itself expand into
      // part of the command (`[paste #…]` → `/goal …`, or completing a
      // partial prefix like `/go[paste #1 …]` → `/goal …`), so any input
      // containing a marker that can still become a `/goal` command must
      // pass the gate as well.
      const trimmed = text.trimStart();
      const mightBeGoal =
        trimmed.startsWith('/goal') ||
        trimmed.startsWith('[paste #') ||
        (trimmed.startsWith('/') && trimmed.includes('[paste #'));
      if (editor.inputMode !== 'bash' && mightBeGoal) {
        host.updateGoalLengthWarning(editor.getExpandedText());
      } else {
        host.updateGoalLengthWarning(undefined);
      }
    };

    // bash mode recalls only shell (`!`-prefixed) history entries; prompt mode
    // recalls everything. The filter is locked to the mode captured when the
    // user first enters history browsing (see onHistoryDraftSave), so landing on
    // a shell entry mid-browse doesn't switch the filter to shell-only.
    let browseMode: 'prompt' | 'bash' | null = null;
    editor.setHistoryFilter((entry: string) => {
      const mode = browseMode ?? editor.inputMode;
      return mode === 'bash' ? entry.startsWith('!') : true;
    });

    // Recalling a `!`-prefixed entry strips the marker and returns to bash
    // mode; recalling a plain entry returns to prompt mode. The filter above
    // guarantees bash mode only ever lands on `!` entries, so this never
    // misfires on commands typed in bash mode.
    editor.onRecall = (entry: string) => {
      if (entry.startsWith('!')) {
        editor.setInputMode('bash');
        return entry.slice(1);
      }
      editor.setInputMode('prompt');
      return undefined;
    };

    // Save/restore the input mode alongside pi-tui's history draft. Without
    // this, recalling a shell entry and then pressing Down back to an empty
    // draft would leave the editor stuck in bash mode, so the next typed
    // message would be submitted as a shell command. Also locks the history
    // filter (browseMode) for the duration of the browse session.
    editor.onHistoryDraftSave = () => {
      browseMode = editor.inputMode;
      return editor.inputMode;
    };
    editor.onHistoryDraftRestore = (state: unknown) => {
      editor.setInputMode(state as 'prompt' | 'bash');
      browseMode = null;
    };

    editor.onNonEscapeInput = () => {
      this.clearPendingUndoEsc();
    };

    editor.onCtrlC = () => {
      if (host.cancelInFlight !== undefined) {
        const cancel = host.cancelInFlight;
        host.cancelInFlight = undefined;
        this.clearPendingExit();
        cancel();
        return;
      }

      // The btw panel stacks above the transcript, so Ctrl+C cancels/closes it
      // before touching an in-flight compaction or stream.
      if (host.btwPanelController.cancelRunning()) {
        this.clearPendingExit();
        return;
      }
      if (host.btwPanelController.closeOrCancel()) {
        this.clearPendingExit();
        return;
      }

      if (host.state.appState.isCompacting) {
        this.clearPendingExit();

        if (this.clearEditorTextIfPresent()) return;

        this.cancelCurrentCompaction();
        return;
      }

      if (host.state.appState.streamingPhase !== 'idle') {
        this.clearPendingExit();

        if (this.clearEditorTextIfPresent()) return;

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
      if (this.pendingExit?.kind === 'ctrl-d') {
        this.clearPendingExit();
        void host.stop();
        return;
      }
      this.armPendingExit('ctrl-d', CTRL_D_HINT);
    };

    editor.onEscape = () => {
      if (this.pendingExit) this.clearPendingExit();
      if (host.state.activeDialog === 'session-picker') {
        host.hideSessionPicker();
        this.clearPendingUndoEsc();
        return;
      }
      // The btw panel stacks above the transcript, so Esc dismisses it before
      // touching an in-flight compaction or stream.
      if (host.btwPanelController.closeOrCancel()) {
        this.clearPendingUndoEsc();
        return;
      }
      if (host.state.appState.isCompacting) {
        this.cancelCurrentCompaction();
        this.clearPendingUndoEsc();
        return;
      }
      if (host.state.appState.streamingPhase !== 'idle') {
        this.cancelCurrentStream();
        this.clearPendingUndoEsc();
        return;
      }
      // Idle: a second Esc within the double-tap window opens the undo selector.
      if (this.pendingUndoEsc !== null) {
        this.clearPendingUndoEsc();
        host.openUndoSelector();
        return;
      }
      this.armPendingUndoEsc();
    };

    editor.onShiftTab = () => {
      const togglePlan = (): void => {
        const next = !host.state.appState.planMode;
        host.track('shortcut_plan_toggle', { enabled: next });
        host.track('shortcut_mode_switch', { to_mode: next ? 'plan' : 'agent' });
        host.handlePlanToggle(next);
      };
      if (host.session === undefined) {
        if (!host.engineV2) {
          host.showError(NO_ACTIVE_SESSION_MESSAGE);
          return;
        }
        // v2 session-less: lazy-create the session, then toggle — the same
        // path /plan takes.
        void host.ensureSession().then((session) => {
          if (session !== undefined) togglePlan();
        });
        return;
      }
      togglePlan();
    };

    editor.onInputModeChange = (mode) => {
      host.handleInputModeChange(mode);
    };

    editor.onOpenExternalEditor = () => {
      host.track('shortcut_editor');
      void this.openExternalEditor();
    };

    editor.onToggleToolExpand = () => {
      host.track('shortcut_expand');
      host.toggleToolOutputExpansion();
    };

    editor.onToggleTodoExpand = (): boolean => {
      if (!host.state.todoPanel.hasOverflow()) return false;
      // Disarm a pending double-press exit confirmation so expanding the
      // todo list in between two Ctrl-C presses does not accidentally exit.
      this.clearPendingExit();
      host.track('shortcut_todo_expand');
      host.toggleTodoPanelExpansion();
      return true;
    };

    editor.onCtrlS = () => {
      if (
        host.state.appState.streamingPhase === 'idle' ||
        host.state.appState.streamingPhase === 'shell' ||
        host.state.appState.isCompacting
      )
        return;
      const text = editor.getText().trim();
      const editorIsBash = editor.inputMode === 'bash';

      // Bash commands (`! …`) are not steerable: they stay queued so they run
      // after the current task. Grouped inline-skill submissions are not
      // steerable either — steer carries no skill activations, so they stay
      // queued and submit intact when the session drains; the same applies to
      // an editor draft carrying inline skill tokens. Steering stops at the
      // first such bundle: items behind it stay queued too, or a later
      // message would jump ahead of its bundle and reverse the conversational
      // order. Everything else steers in queue order — plain text as a
      // steered message, slash-skill items as activations fired into the
      // running turn (never as literal text).
      const queued = host.state.queuedMessages;
      const firstBundle = queued.findIndex((m) => m.inlineSkillActivations !== undefined);
      const windowBeforeFirstBundle = firstBundle === -1 ? queued : queued.slice(0, firstBundle);
      const steerable = windowBeforeFirstBundle.filter((m) => m.mode !== 'bash');
      const editorHasInlineSkills =
        !editorIsBash &&
        text.length > 0 &&
        host.engineV2 &&
        extractInlineSkillActivations(text, host.skillCommandMap).length > 0;

      type SteerRun =
        | { readonly kind: 'text'; readonly items: SteerInputItem[] }
        | { readonly kind: 'skill'; readonly skillName: string; readonly skillArgs: string };
      const runs: SteerRun[] = [];
      let textRun: SteerInputItem[] = [];
      const flushTextRun = (): void => {
        if (textRun.length > 0) {
          runs.push({ kind: 'text', items: textRun });
          textRun = [];
        }
      };
      for (const m of steerable) {
        if (m.mode === 'skill' && m.skillName !== undefined) {
          flushTextRun();
          runs.push({ kind: 'skill', skillName: m.skillName, skillArgs: m.skillArgs ?? '' });
          continue;
        }
        const trimmed = m.text.trim();
        if (trimmed.length > 0) {
          // Queued items carry the parts extracted when they were submitted
          // (and were already capability-validated then).
          textRun.push({
            text: trimmed,
            parts: m.parts,
            imageAttachmentIds: m.imageAttachmentIds,
            stagingPaths: m.stagingPaths,
          });
        }
      }
      let editorExtraction: ReturnType<typeof extractMediaAttachments> | undefined;
      if (!editorIsBash && text.length > 0 && !editorHasInlineSkills && firstBundle === -1) {
        try {
          // Synchronous path: an image still ingesting in the background
          // extracts to its inline fallback here (no bounded wait like
          // `sendNormalUserInput` — this handler cannot await without
          // interleaving queue/draft edits).
          editorExtraction = extractMediaAttachments(text, this.imageStore);
        } catch (error) {
          // Cache copy failed (e.g. the pasted video's source vanished) —
          // leave the queue and the editor draft untouched.
          host.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
          return;
        }
        textRun.push({
          text,
          parts: editorExtraction.hasMedia ? editorExtraction.parts : undefined,
          imageAttachmentIds:
            editorExtraction.imageAttachmentIds.length > 0
              ? editorExtraction.imageAttachmentIds
              : undefined,
          stagingPaths: editorExtraction.stagingPaths,
        });
      }
      flushTextRun();

      if (runs.length > 0) {
        // The editor draft is fresh input: gate it on the model's media
        // capabilities before splicing the queue, so a rejection leaves the
        // queue and the draft untouched.
        if (
          editorExtraction !== undefined &&
          !host.validateMediaCapabilities(editorExtraction)
        ) {
          host.releaseStagingMedia(
            editorExtraction.imageAttachmentIds,
            editorExtraction.stagingPaths,
          );
          return;
        }
        const session = host.session;
        if (host.state.appState.model.trim().length === 0 || session === undefined) {
          host.releaseStagingMedia(
            editorExtraction?.imageAttachmentIds ?? [],
            editorExtraction?.stagingPaths ?? [],
          );
          host.showError(LLM_NOT_SET_MESSAGE);
          return;
        }
        host.state.queuedMessages = queued.filter(
          (m, index) => m.mode === 'bash' || (firstBundle !== -1 && index >= firstBundle),
        );
        if (!editorIsBash && !editorHasInlineSkills && firstBundle === -1) editor.setText('');
        for (const run of runs) {
          if (run.kind === 'text') {
            host.steerMessage(session, run.items);
          } else {
            host.steerSkillActivation(session, run.skillName, run.skillArgs);
          }
        }
      }
      host.updateQueueDisplay();
      host.state.ui.requestRender();
    };

    editor.onCtrlB = (): boolean => {
      // Shell command execution is treated as a streaming phase ('shell'), so
      // this gate already covers it; only idle + not-compacting falls through.
      if (host.state.appState.streamingPhase === 'idle' || host.state.appState.isCompacting) {
        return false;
      }
      host.track('shortcut_background_task');
      host.detachCurrentForegroundTask();
      return true;
    };

    editor.onUndo = () => {
      host.track('undo');
    };

    editor.onTextPaste = () => {
      host.track('shortcut_paste', { kind: 'text' });
    };

    editor.onUpArrowEmpty = () => {
      if (host.btwPanelController.scroll('up')) return true;
      if (host.state.appState.streamingPhase === 'idle' && !host.state.appState.isCompacting) return false;
      const recalled = host.recallLastQueued();
      if (recalled !== undefined) {
        editor.setText(recalled.text);
        // Restore the queued item's mode so a recalled `!` command runs as a
        // shell command again instead of being submitted as a normal prompt.
        // Skill activations recall as prompt mode: their text is the original
        // `/name args` slash command, which re-parses on submit.
        const mode = recalled.mode === 'bash' ? 'bash' : 'prompt';
        if (editor.inputMode !== mode) {
          editor.inputMode = mode;
          editor.onInputModeChange?.(mode);
        }
        host.updateQueueDisplay();
        host.state.ui.requestRender();
        return true;
      }
      return false;
    };

    editor.onDownArrowEmpty = () => host.btwPanelController.scroll('down');

    editor.onPasteImage = async () => this.handleClipboardImagePaste();
  }

  clearPendingExit(): void {
    if (!this.pendingExit) return;
    clearTimeout(this.pendingExit.timer);
    this.host.state.footer.setTransientHint(null);
    this.pendingExit = null;
  }

  dispose(): void {
    this.clearPendingExit();
    this.clearPendingUndoEsc();
  }

  private armPendingUndoEsc(): void {
    this.clearPendingUndoEsc();
    const timer = setTimeout(() => {
      if (this.pendingUndoEsc?.timer === timer) {
        this.pendingUndoEsc = null;
      }
    }, DOUBLE_ESC_WINDOW_MS);
    this.pendingUndoEsc = { timer };
  }

  private clearPendingUndoEsc(): void {
    if (!this.pendingUndoEsc) return;
    clearTimeout(this.pendingUndoEsc.timer);
    this.pendingUndoEsc = null;
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

  private clearEditorTextIfPresent(): boolean {
    const editor = this.host.state.editor;
    if (editor.getText().length === 0) return false;
    editor.setText('');
    return true;
  }

  private cancelCurrentStream(): void {
    // Cancel any running `!` shell command (treated as a streaming phase) in
    // addition to the agent turn, so Esc / Ctrl+C interrupts it too.
    this.host.cancelRunningShellCommand();
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

    // Register the attachment and put its placeholder in the editor before
    // any of the asynchronous ingestion work below. CustomEditor only holds
    // keystrokes until this handler settles, so the callback returns right
    // after the placeholder lands and ingestion continues in the background —
    // typing never waits on compression or the daemon upload. Submit gives a
    // pending ingestion a bounded wait (`pendingImageIngestions`) and falls
    // back to the inline form when it has not finished.
    const attachment = this.imageStore.addImage(
      media.bytes,
      meta.mime,
      meta.width,
      meta.height,
    );
    this.host.state.editor.insertTextAtCursor?.(`${attachment.placeholder} `);
    this.host.state.ui.requestRender();
    this.host.track('shortcut_paste', { kind: 'image' });

    attachment.pending = this.finishClipboardImagePaste(
      attachment,
      media.bytes,
      meta.mime,
      meta.width,
      meta.height,
    ).catch((error: unknown) => {
      // The raw attachment and its already-visible placeholder are still a
      // valid inline fallback when optional ingestion work fails.
      this.host.showError(`Failed to process pasted image: ${formatErrorMessage(error)}`);
    });
    return true;
  }

  private async finishClipboardImagePaste(
    attachment: ImageAttachment,
    originalBytes: Uint8Array,
    originalMime: string,
    originalWidth: number,
    originalHeight: number,
  ): Promise<void> {
    // Compress at ingestion — a pure data step while building the attachment, so
    // the stored bytes, the inline thumbnail, the `[image #N (W×H)]` placeholder,
    // and the submitted image all agree, and the agent core only ever sees an
    // already-compressed image. Best effort: originals pass through on failure.
    // When compression changed the bytes, the original is persisted (into the
    // session's media-originals dir when known, else the temp-dir fallback)
    // and recorded on the attachment, so submit-time expansion can announce
    // the compression and point the model at the full-fidelity copy.
    // The edge cap comes from the host harness's [image] config (resolved per
    // paste so a config reload applies immediately); hosts without a harness
    // use the env/built-in default.
    const compressed = await compressImageForModel(originalBytes, originalMime, {
      maxEdge: this.host.harness?.imageLimits?.maxEdgePx(),
      telemetry: {
        client: {
          track: (event, properties) =>
            this.host.track(event, properties === undefined ? undefined : { ...properties }),
        },
        source: 'tui_paste',
      },
    });
    const sessionDir = this.host.session?.summary?.sessionDir;
    // Dimensions come from the compression result, not parseImageMeta: the
    // compressor reports display space (EXIF orientation applied) — the space
    // the sent image, the caption, and ReadMediaFile region readback share —
    // while parseImageMeta reads the raw pre-rotation header.
    // Persist the original BEFORE minting a daemon upload: when persistence
    // fails the whole ingestion is abandoned, and an upload minted earlier
    // would be orphaned (never attached, never deleted).
    const original = compressed.changed
      ? {
          path: await persistOriginalImage(
            originalBytes,
            originalMime,
            sessionDir === undefined ? {} : { dir: sessionMediaOriginalsDir(sessionDir) },
          ),
          width: compressed.originalWidth,
          height: compressed.originalHeight,
          byteLength: originalBytes.length,
          mime: originalMime,
        }
      : undefined;
    // v2 only: upload the final bytes to the daemon file store so submit-time
    // expansion emits a `kimi-file://` reference instead of inline base64.
    const uploaded = await this.uploadImageToDaemonFileStore(
      compressed.changed ? compressed.data : originalBytes,
      compressed.changed ? compressed.mimeType : originalMime,
    );
    const completed = this.imageStore.completeImage(attachment, {
      bytes: compressed.changed ? compressed.data : originalBytes,
      mime: compressed.changed ? compressed.mimeType : originalMime,
      width: compressed.width || originalWidth,
      height: compressed.height || originalHeight,
      original,
      fileId: uploaded?.id,
      fileExpiresAt: parseExpiry(uploaded),
    });
    if (completed === undefined && uploaded !== undefined) {
      await this.host.harness?.deleteFile(uploaded.id).catch(() => undefined);
    }
    if (completed === undefined && original !== undefined && original.path !== null) {
      await unlink(original.path).catch(() => undefined);
    }
    this.host.state.ui.requestRender();
  }

  /**
   * Paste-time upload of the final image bytes to the engine's daemon file
   * store (agent-core-v2 only), run as part of the background ingestion —
   * typing never waits on it, and submit only gives it the bounded
   * `pendingImageIngestions` wait. Best effort: any failure returns undefined,
   * so the attachment keeps no `fileId` and submit-time expansion falls back
   * to the inline base64 form.
   */
  private async uploadImageToDaemonFileStore(
    bytes: Uint8Array,
    mime: string,
  ): Promise<FileMeta | undefined> {
    if (!this.host.engineV2) return undefined;
    const harness = this.host.harness;
    if (harness === undefined) return undefined;
    try {
      const meta = await harness.uploadFile(bytes, {
        name: `pasted-image.${imageExtensionForMime(mime)}`,
        mimeType: mime,
        expiresInSec: IMAGE_STAGING_TTL_SECONDS,
      });
      return meta;
    } catch {
      return undefined;
    }
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
    // Fullscreen: a plain stop() would replay the whole transcript into the
    // main screen on exit; the external editor only needs the alternate
    // screen released, so preserve the screen instead.
    state.ui.stop({ preserveScreen: state.ui.mode === 'fullscreen' ? true : undefined });
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
      // terminal.stop() cleared the OSC 9;4 progress indicator while the
      // app-side progressActive flag still reads true; resync so a turn that
      // was streaming while the editor was open gets its progress back.
      state.terminalState.progressActive = false;
      this.host.updateActivityPane();
      this.host.setExternalEditorRunning(false);
    }
  }
}

function parseExpiry(meta: FileMeta | undefined): number | undefined {
  if (meta?.expires_at === undefined) return undefined;
  const value = Date.parse(meta.expires_at);
  return Number.isFinite(value) ? value : undefined;
}
