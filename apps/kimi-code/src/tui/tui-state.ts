import {
  Container,
  ProcessTerminal,
  type Component,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  type TUI,
  type TuiRightClickPasteRequest,
} from '@moonshot-ai/pi-tui';

import { TranscriptContainer } from '#/tui/components/messages/transcript-container';
import { TranscriptView } from '#/tui/components/messages/transcript-view';
import { copyTextToClipboard, readClipboardText } from '#/utils/clipboard/clipboard-text';
import { openUrl } from '#/utils/open-url';

import { DockSection } from './components/chrome/dock-section';
import { FooterComponent } from './components/chrome/footer';
import { GutterContainer } from './components/chrome/gutter-container';
import type { MoonLoader, SpinnerStyle } from './components/chrome/moon-loader';
import { NotifyPanelComponent } from './components/chrome/notify-panel';
import { BtwPanelComponent } from './components/panes/btw-panel';
import { QueuePaneComponent } from './components/panes/queue-pane';
import type { SessionRow, SessionsScope } from './components/dialogs/session-picker';
import { CustomEditor } from './components/editor/custom-editor';
import { DEFAULT_MARKDOWN_CONFIG, DEFAULT_MOUSE_CONFIG, DEFAULT_TUI_CONFIG } from './config';
import { CHROME_GUTTER, DOCK_QUEUE_ROWS, DOCK_UPDATES_ROWS } from './constant/rendering';
import { CLICK_GUARD_MS } from './constant/terminal';
import type { TasksBrowserState } from './controllers/tasks-browser';
import { currentTheme, type Theme } from './theme';
import {
  INITIAL_LIVE_PANE,
  type AppState,
  type KimiTUIOptions,
  type LivePaneState,
  type QueuedMessage,
  type TranscriptEntry,
  type TUIStartupState,
} from './types';
import { formatErrorMessage } from './utils/event-payload';
import {
  setMarkdownAltScreenActive,
  setMarkdownMermaidMode,
  setMarkdownRenderLatex,
  setMarkdownRenderRequester,
} from './utils/markdown-options';
import { createTerminalState, type TerminalState } from './utils/terminal-state';

export interface TUIState {
  ui: TUI;
  terminal: ProcessTerminal;
  transcriptContainer: TranscriptContainer;
  transcriptView?: TranscriptView;
  activityContainer: Container;
  notifyPanelContainer: Container;
  notifyPanel: NotifyPanelComponent;
  queueContainer: Container;
  queuePane: QueuePaneComponent;
  btwPanelContainer: Container;
  surveyContainer: Container;
  editorContainer: Container;
  dockContainer: VStack | undefined;
  editorSlot: VStack | undefined;
  footer: FooterComponent;
  editor: CustomEditor;
  theme: Theme;
  appState: AppState;
  startupState: TUIStartupState;
  livePane: LivePaneState;
  transcriptEntries: TranscriptEntry[];
  terminalState: TerminalState;
  activitySpinner: { instance: MoonLoader; style: SpinnerStyle } | null;
  sessions: SessionRow[];
  loadingSessions: boolean;
  sessionsNextCursor: string | undefined;
  sessionsLoadingMore: boolean;
  sessionsScope: SessionsScope;
  activeDialog:
    | 'session-picker'
    | 'help'
    | 'trust-prompt'
    | 'cache-hint'
    | 'model-switch-confirm'
    | 'goal-start'
    | null;
  editorReplacementMounted: boolean;
  tasksBrowser: TasksBrowserState | undefined;
  externalEditorRunning: boolean;
  queuedMessages: QueuedMessage[];
  queuedMessageDispatchPending: boolean;
  swarmModeEntry: 'manual' | 'task' | undefined;
}

export function createTUIState(options: KimiTUIOptions): TUIState {
  const initialAppState = options.initialAppState;
  const theme = currentTheme;

  const terminal = new ProcessTerminal();
  setMarkdownRenderLatex(initialAppState.renderLatex ?? DEFAULT_TUI_CONFIG.renderLatex ?? true);
  setMarkdownMermaidMode(initialAppState.markdown?.mermaid ?? DEFAULT_MARKDOWN_CONFIG.mermaid);
  const fullscreen = (options.resolvedTuiMode ?? initialAppState.tuiMode) === 'fullscreen';
  const selectionCopyMode = initialAppState.selectionCopyMode ?? 'immediate';
  const mouse = initialAppState.mouse ?? DEFAULT_MOUSE_CONFIG;
  const ui = fullscreen
      ? new TuiAltScreen(terminal, undefined, undefined, {
          openUrl,
          refocusMouseGuardMs: CLICK_GUARD_MS,
          wheelScrollLines: mouse.wheelScrollLines,
          altWheelAcceleration: mouse.altWheelAcceleration,
          searchSelectAll: true,
          editorSelection: true,
          copyOnSelect: selectionCopyMode === 'immediate',
          copyOnRightClick: selectionCopyMode === 'right-click',
          onRightClickPaste: (request: TuiRightClickPasteRequest) => {
            const target = ui.getFocusedComponent();
            if (!target?.handleInput || !request.isCurrent()) return;
            void readClipboardText()
              .then((text) => {
                if (!request.isCurrent() || !text || ui.getFocusedComponent() !== target) return;
                ui.dispatchInput(`\u001B[200~${text}\u001B[201~`);
              })
              .catch((error: unknown) => {
                if (ui instanceof TuiAltScreen) ui.flash(formatErrorMessage(error), 5000);
              });
          },
          scrollToEndIndicator: () => currentTheme.fg('primary', ' ↓ Jump to bottom '),
          copySelection: async (text) => {
            try {
              const method = await copyTextToClipboard(text);
              return method === 'native' ? true : { copied: true, message: 'Copied via terminal' };
            } catch (error) {
              return formatErrorMessage(error);
            }
          },
        })
      : new TuiMainScreen(terminal);
  if (options.animationFrameRate !== undefined) ui.setAnimationFrameRate(options.animationFrameRate);

  setMarkdownAltScreenActive(ui instanceof TuiAltScreen);
  setMarkdownRenderRequester(() => {
    ui.requestRender(true);
  });

  const transcriptContainer = new TranscriptContainer(CHROME_GUTTER, CHROME_GUTTER, ui);
  const activityContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const queueContainer = fullscreen ? new VStack() : new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const queuePane = new QueuePaneComponent(fullscreen ? { maxBodyRows: DOCK_QUEUE_ROWS } : undefined);
  const notifyPanelContainer = fullscreen ? new VStack() : new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const notifyPanel = new NotifyPanelComponent(
    fullscreen ? { maxBodyRows: DOCK_UPDATES_ROWS, screenRows: () => ui.terminal.rows } : undefined,
  );
  const btwPanelContainer = fullscreen
    ? new VStack()
    : new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const surveyContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const editorContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const editor = new CustomEditor(ui, {
    disablePasteBurst: initialAppState.disablePasteBurst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
  });
  const footer = new FooterComponent(
    { ...initialAppState },
    () => {
      ui.requestRender();
    },
    fullscreen,
  );

  let transcriptView: TranscriptView | undefined;
  let dockContainer: VStack | undefined;
  let editorSlot: VStack | undefined;
  if (ui instanceof TuiAltScreen) {
    const fullscreenView = new TranscriptView(transcriptContainer);
    transcriptView = fullscreenView;
    dockContainer = new VStack();
    dockContainer.addChild(activityContainer, { shrink: 1, minSize: 0 });
    dockContainer.addChild(notifyPanelContainer, { shrink: 1, minSize: 0 });
    const unlessBlocked = (): boolean => !isBlockingPromptPending(state);
    dockContainer.addChild(queueContainer, { shrink: 1, minSize: 0, visible: unlessBlocked });
    dockContainer.addChild(btwPanelContainer, { shrink: 1, minSize: 0, visible: unlessBlocked });
    dockContainer.addChild(surveyContainer, { shrink: 0, minSize: 0 });
    editorSlot = new VStack();
    editorSlot.addChild(editorContainer, EDITOR_SLOT_ENTRY);
    dockContainer.addChild(editorSlot, EDITOR_SLOT_ENTRY);
    const root = new VStack();
    root.addChild(fullscreenView, { basis: 0, grow: 1, shrink: 1, minSize: 1 });
    root.addChild(dockContainer, { basis: 'auto', grow: 0, shrink: 1, minSize: 1 });
    ui.setLayoutRoot(root);
    ui.addLayoutEffect(() => {
      if (ui.getLayoutRoot() !== root) return;
      const stickyChanged = fullscreenView.updateStickyMessage();
      const dockOverflowChanged = consumeDockOverflowChange(state);
      if (stickyChanged || dockOverflowChanged) ui.requestRender();
    });
  }

  const state: TUIState = {
    ui,
    terminal,
    transcriptContainer,
    transcriptView,
    activityContainer,
    notifyPanelContainer,
    notifyPanel,
    queueContainer,
    queuePane,
    btwPanelContainer,
    surveyContainer,
    editorContainer,
    dockContainer,
    editorSlot,
    editor,
    footer,
    theme,
    appState: { ...initialAppState },
    startupState: 'pending',
    livePane: { ...INITIAL_LIVE_PANE },
    transcriptEntries: [],
    terminalState: createTerminalState(),
    activitySpinner: null,
    sessions: [],
    loadingSessions: false,
    sessionsNextCursor: undefined,
    sessionsLoadingMore: false,
    sessionsScope: 'cwd',
    activeDialog: null,
    editorReplacementMounted: false,
    tasksBrowser: undefined,
    externalEditorRunning: false,
    queuedMessages: [],
    queuedMessageDispatchPending: false,
    swarmModeEntry: undefined,
  };
  return state;
}

export function mountFooter(state: TUIState): void {
  const footerWrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  footerWrap.addChild(state.footer);
  const dock = state.dockContainer;
  if (dock === undefined) {
    state.ui.addChild(footerWrap);
    return;
  }
  dock.addChild(footerWrap, {
    shrink: 1,
    minSize: 1,
    visible: () => !isBlockingPromptPending(state),
  });
}

const EDITOR_SLOT_ENTRY = { shrink: 1, minSize: 3 } as const;

export function setEditorSlot(
  state: Pick<TUIState, 'editorContainer' | 'editorSlot'>,
  component: Component,
): void {
  const { editorContainer, editorSlot } = state;
  editorContainer.clear();
  if (editorSlot === undefined) {
    editorContainer.addChild(component);
    return;
  }
  editorSlot.clear();
  if (component instanceof DockSection && component.layout !== undefined) {
    editorSlot.addChild(component, EDITOR_SLOT_ENTRY);
    return;
  }
  editorContainer.addChild(component);
  editorSlot.addChild(editorContainer, EDITOR_SLOT_ENTRY);
}

export function editorSlotComponent(
  state: Pick<TUIState, 'editorContainer' | 'editorSlot'>,
): Component | undefined {
  const slotted = state.editorSlot?.children[0];
  return slotted === undefined || slotted === state.editorContainer
    ? state.editorContainer.children[0]
    : slotted;
}

export function isBlockingPromptPending(state: Pick<TUIState, 'livePane' | 'activeDialog'>): boolean {
  return (
    state.livePane.pendingApproval !== null ||
    state.livePane.pendingQuestion !== null ||
    state.activeDialog === 'goal-start'
  );
}

function consumeDockOverflowChange(
  state: Pick<
    TUIState,
    'notifyPanel' | 'queuePane' | 'btwPanelContainer' | 'editorContainer' | 'editorSlot'
  >,
): boolean {
  let changed = state.notifyPanel.consumeOverflowChange();
  if (state.queuePane.consumeOverflowChange()) changed = true;
  for (const child of state.btwPanelContainer.children) {
    if (child instanceof BtwPanelComponent && child.consumeOverflowChange()) changed = true;
  }
  const active = editorSlotComponent(state);
  if (active instanceof DockSection && active.consumeOverflowChange()) changed = true;
  return changed;
}
