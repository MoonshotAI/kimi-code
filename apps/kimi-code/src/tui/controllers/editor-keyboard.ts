import { readFile } from 'node:fs/promises';

import type { FileMeta, KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';
import { compressImageForModel } from '@moonshot-ai/kimi-code-sdk';

import {
  ClipboardMediaError,
  readClipboardMedia,
  type ClipboardVideo,
} from '#/utils/clipboard/clipboard-image';
import { parseImageMeta } from '#/utils/image/image-mime';
import { editInExternalEditor, resolveEditorCommand } from '#/utils/process/external-editor';

import {
  CTRL_C_HINT,
  CTRL_D_HINT,
  DOUBLE_ESC_WINDOW_MS,
  EXIT_CONFIRM_WINDOW_MS,
  LLM_NOT_SET_MESSAGE,
} from '../constant/kimi-tui';
import { isKeyRelease, isKeyRepeat, Key, matchesKey, TuiAltScreen } from '@moonshot-ai/pi-tui';
import { normalizeCapsLockedCtrl } from '../components/editor/custom-editor';
import { FOLLOW_UP_KEYMAP, resolveFollowUpBehavior, type FollowUpDelivery } from '../config';
import { MEDIA_STAGING_TTL_SECONDS } from '../constant/media';
import { formatErrorMessage } from '../utils/event-payload';
import type {
  ImageAttachment,
  ImageAttachmentStore,
  VideoAttachment,
} from '../utils/image-attachment-store';
import { extractMediaAttachments, imageExtensionForMime } from '../utils/image-placeholder';
import { resolveUserInput } from '../commands/resolve';
import type { PendingExit, QueuedMessage } from '../types';
import type { TUIState } from '../tui-state';
import type { BtwPanelController } from './btw-panel';
import type { SurveyController } from './survey-controller';
import type { ModelMigrationController } from './model-migration';
import type { WorktreeCreationController } from './worktree-creation';

export interface EditorKeyboardHost {
  state: TUIState;
  session: Session | undefined;
  cancelInFlight: (() => void) | undefined;
  harness?: KimiHarness | undefined;

  handleUserInput(text: string, delivery?: FollowUpDelivery): void;
  readonly btwPanelController: BtwPanelController;
  readonly surveyController: SurveyController;
  readonly modelMigration?: ModelMigrationController;
  readonly worktreeCreation?: Pick<WorktreeCreationController, 'busy' | 'cancel'>;
  readonly promptPredictionController?: import('./prompt-prediction').PromptPredictionController;
  readonly skillCommandMap: Map<string, string>;
  readonly pluginCommandMap: Map<string, string>;
  readonly skillVariantPathForCommand?: (commandName: string, tokenStart: number) => string | undefined;
  readonly defaultSkillPathForCommand?: (commandName: string) => string | undefined;
  retainSkillVariantSelection?(text: string): void;
  beginInputHistoryRecall?(): void;
  restoreInputHistoryEntry?(direction: 1 | -1): void;
  restoreInputHistoryDraft?(): void;
  steerQueuedMessagesIntoRunningTurn(manual?: boolean): void;
  validateMediaCapabilities(extraction: {
    hasMedia: boolean;
    imageAttachmentIds: readonly number[];
    videoAttachmentIds: readonly number[];
  }): boolean;
  releaseStagingMedia(mediaAttachmentIds: readonly number[]): void;
  recallLastQueued(): QueuedMessage | undefined;
  isSteeringQueuedMessages(): boolean;
  showError(msg: string): void;
  track(event: string, props?: Record<string, unknown>): void;
  updateEditorBorderHighlight(text?: string): void;
  updateGoalLengthWarning(text: string | undefined): void;
  updateQueueDisplay(): void;
  toggleToolOutputExpansion(): void;
  openTasksBrowser(): void;
  focusNotifyPanel(): boolean;
  detachCurrentForegroundTask(): void;
  cancelRunningShellCommand(): void;
  hideSessionPicker(): void;
  openUndoSelector(): void;
  requestExit(): Promise<void>;
  ensureSession(): Promise<Session | undefined>;
  handlePlanToggle(next: boolean): void;
  handleInputModeChange(mode: 'prompt' | 'bash'): void;
  clearQueuedMessages(): void;
  setExternalEditorRunning(running: boolean): void;
  updateActivityPane(): void;
}

const SELECTION_COPY_KEYS = [Key.ctrl('c'), Key.ctrlShift('c'), Key.super('c')];

export class EditorKeyboardController {
  private disposeSelectionCopy: (() => void) | undefined;
  private copyKeyHeld = false;
  private pendingExit: PendingExit | null = null;
  private pendingUndoEsc: { readonly timer: ReturnType<typeof setTimeout> } | null = null;
  private disposed = false;

  constructor(
    private readonly host: EditorKeyboardHost,
    private readonly imageStore: ImageAttachmentStore,
  ) {}

  install(): void {
    const { host } = this;
    const editor = host.state.editor;

    editor.onSubmit = (text: string) => {
      if (host.surveyController.handleSubmit(text)) return;
      host.promptPredictionController?.handleSubmit(text);
      const behavior = resolveFollowUpBehavior(host.state.appState.followUpBehavior);
      host.handleUserInput(text, FOLLOW_UP_KEYMAP[behavior][editor.submitKey]);
    };

    editor.onPreInput = (data: string) => {
      if (this.disposed) return true;
      if (matchesKey(data, Key.escape)) this.clearPendingExit();
      if (host.surveyController.handlePreInput(data)) {
        this.clearPendingUndoEsc();
        return true;
      }
      if (host.promptPredictionController?.handlePreInput(data) === true) {
        this.clearPendingUndoEsc();
        return true;
      }
      return false;
    };

    editor.onChange = (text: string) => {
      if (this.pendingExit) this.clearPendingExit();
      host.promptPredictionController?.handleEditorChange(text);
      host.surveyController.handleEditorChange(text);
      if (text === '') queueMicrotask(() => host.retainSkillVariantSelection?.(editor.getText()));
      else host.retainSkillVariantSelection?.(text);
      host.updateEditorBorderHighlight(text);
      if (text.length === 0) host.modelMigration?.retry();
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

    let browseMode: 'prompt' | 'bash' | null = null;
    editor.setHistoryFilter((entry: string) => {
      const mode = browseMode ?? editor.inputMode;
      return mode === 'bash' ? entry.startsWith('!') : true;
    });

    editor.onRecall = (entry: string, direction: 1 | -1) => {
      host.restoreInputHistoryEntry?.(direction);
      if (entry.startsWith('!')) {
        editor.setInputMode('bash');
        return entry.slice(1);
      }
      editor.setInputMode('prompt');
      return undefined;
    };

    editor.onHistoryDraftSave = () => {
      host.beginInputHistoryRecall?.();
      browseMode = editor.inputMode;
      return editor.inputMode;
    };
    editor.onHistoryDraftRestore = (state: unknown) => {
      host.restoreInputHistoryDraft?.();
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

      if (host.btwPanelController.cancelRunning()) {
        this.clearPendingExit();
        return;
      }
      if (host.btwPanelController.closeOrCancel()) {
        this.clearPendingExit();
        return;
      }

      if (
        host.worktreeCreation?.busy === true &&
        (this.clearEditorTextIfPresent() || host.worktreeCreation.cancel())
      ) {
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
        void host.requestExit();
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
        void host.requestExit();
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
      if (host.btwPanelController.closeOrCancel()) {
        this.clearPendingUndoEsc();
        return;
      }
      if (host.worktreeCreation?.cancel() === true) {
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
      host.surveyController.notifyDisplaced();
      host.track('shortcut_editor');
      void this.openExternalEditor();
    };

    editor.onToggleToolExpand = () => {
      host.track('shortcut_expand');
      host.toggleToolOutputExpansion();
    };

    editor.onPageNotify = (): boolean => {
      if (!host.focusNotifyPanel()) return false;
      this.clearPendingExit();
      host.track('shortcut_notify_page');
      return true;
    };

    editor.onCtrlS = () => {
      if (
        host.state.appState.streamingPhase === 'idle' ||
        host.state.appState.streamingPhase === 'shell' ||
        host.state.appState.isCompacting ||
        host.isSteeringQueuedMessages()
      ) return;
      const text = (editor.getExpandedText?.() ?? editor.getText()).trim();
      const editorIsBash = editor.inputMode === 'bash';
      let extraction: ReturnType<typeof extractMediaAttachments> | undefined;
      if (!editorIsBash && text.length > 0) {
        try {
          extraction = extractMediaAttachments(text, this.imageStore);
        } catch (error) {
          host.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
          return;
        }
        if (!host.validateMediaCapabilities(extraction)) {
          host.releaseStagingMedia([
            ...extraction.imageAttachmentIds,
            ...extraction.videoAttachmentIds,
          ]);
          return;
        }
      }
      if (host.state.appState.model.trim().length === 0 || host.session === undefined) {
        host.releaseStagingMedia([
          ...(extraction?.imageAttachmentIds ?? []),
          ...(extraction?.videoAttachmentIds ?? []),
        ]);
        host.showError(LLM_NOT_SET_MESSAGE);
        return;
      }
      if (extraction !== undefined) {
        const { activations } = resolveUserInput({
          input: text,
          skillCommandMap: host.skillCommandMap,
          pluginCommandMap: host.pluginCommandMap,
          isStreaming: true,
          isCompacting: host.state.appState.isCompacting,
          skillVariantPathForCommand: host.skillVariantPathForCommand === undefined
            ? undefined
            : (commandName, tokenStart) => host.skillVariantPathForCommand!(commandName, tokenStart),
          defaultSkillPathForCommand: host.defaultSkillPathForCommand === undefined
            ? undefined
            : (commandName) => host.defaultSkillPathForCommand!(commandName),
        });
        host.state.queuedMessages.push({
          text,
          agentId: host.harness?.interactiveAgentId,
          parts: extraction.hasMedia ? extraction.parts : undefined,
          imageAttachmentIds:
            extraction.imageAttachmentIds.length > 0 ? extraction.imageAttachmentIds : undefined,
          videoAttachmentIds:
            extraction.videoAttachmentIds.length > 0 ? extraction.videoAttachmentIds : undefined,
          inlineSkillActivations: activations.length > 0 ? activations : undefined,
        });
        editor.setText('');
      }
      host.steerQueuedMessagesIntoRunningTurn(true);
      host.updateQueueDisplay();
      host.state.ui.requestRender();
    };

    editor.onCtrlB = (): boolean => {
      if (host.state.appState.streamingPhase === 'idle' || host.state.appState.isCompacting) {
        return false;
      }
      host.track('shortcut_background_task');
      host.detachCurrentForegroundTask();
      return true;
    };

    const { ui } = host.state;
    if (ui instanceof TuiAltScreen) {
      this.disposeSelectionCopy = ui.addInputListener((data) => this.handleSelectionCopyKey(ui, data));
    }

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
    this.disposed = true;
    this.disposeSelectionCopy?.();
    this.clearPendingExit();
    this.clearPendingUndoEsc();
  }

  private handleSelectionCopyKey(ui: TuiAltScreen, data: string): { consume: true } | undefined {
    const key = normalizeCapsLockedCtrl(data);
    if (!SELECTION_COPY_KEYS.some((copyKey) => matchesKey(key, copyKey))) return undefined;
    if (isKeyRelease(key)) {
      this.copyKeyHeld = false;
      return undefined;
    }
    if (isKeyRepeat(key)) return this.copyKeyHeld ? { consume: true } : undefined;
    this.copyKeyHeld = false;
    if (!ui.hasActiveSelection()) return undefined;
    this.clearPendingExit();
    this.clearPendingUndoEsc();
    void ui.copyActiveSelectionToClipboard();
    ui.resetTextSelection();
    ui.requestRender();
    this.copyKeyHeld = true;
    return { consume: true };
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
    if (this.host.cancelInFlight !== undefined) {
      const cancel = this.host.cancelInFlight;
      this.host.cancelInFlight = undefined;
      cancel();
      return;
    }
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
      attachment.pending = this.finishClipboardVideoPaste(attachment, media).catch(
        (error: unknown) => {
          this.host.showError(`Failed to process pasted video: ${formatErrorMessage(error)}`);
        },
      );
      return true;
    }

    const meta = parseImageMeta(media.bytes);
    if (meta === null) return false;

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
    const original = compressed.changed
      ? {
          bytes: originalBytes,
          width: compressed.originalWidth,
          height: compressed.originalHeight,
          byteLength: originalBytes.length,
          mime: originalMime,
        }
      : undefined;
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
    this.host.state.ui.requestRender();
  }

  private async uploadImageToDaemonFileStore(
    bytes: Uint8Array,
    mime: string,
  ): Promise<FileMeta | undefined> {
    const harness = this.host.harness;
    if (harness === undefined) return undefined;
    try {
      const meta = await harness.uploadFile(bytes, {
        name: `pasted-image.${imageExtensionForMime(mime)}`,
        mimeType: mime,
        expiresInSec: MEDIA_STAGING_TTL_SECONDS,
      });
      return meta;
    } catch {
      return undefined;
    }
  }

  private async uploadVideoToDaemonFileStore(
    media: ClipboardVideo,
  ): Promise<FileMeta | undefined> {
    const harness = this.host.harness;
    if (harness === undefined) return undefined;
    let bytes: Uint8Array;
    try {
      bytes = await readFile(media.sourcePath);
    } catch {
      return undefined;
    }
    try {
      return await harness.uploadFile(bytes, {
        name: media.filename,
        mimeType: media.mimeType,
        expiresInSec: MEDIA_STAGING_TTL_SECONDS,
      });
    } catch {
      return undefined;
    }
  }

  private async finishClipboardVideoPaste(
    attachment: VideoAttachment,
    media: ClipboardVideo,
  ): Promise<void> {
    const uploaded = await this.uploadVideoToDaemonFileStore(media);
    const completed = this.imageStore.completeVideo(attachment, {
      fileId: uploaded?.id,
      fileExpiresAt: parseExpiry(uploaded),
    });
    if (completed === undefined && uploaded !== undefined) {
      await this.host.harness?.deleteFile(uploaded.id).catch(() => undefined);
    }
    this.host.state.ui.requestRender();
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
