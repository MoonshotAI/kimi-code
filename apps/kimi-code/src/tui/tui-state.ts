import {
  Container,
  ProcessTerminal,
  type Component,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  type TUI,
} from '@moonshot-ai/pi-tui';

import { TranscriptView } from '#/tui/components/messages/transcript-view';
import { clipboard } from '#/utils/clipboard/clipboard-native';
import { openUrl } from '#/utils/open-url';

import { DockSection } from './components/chrome/dock-section';
import { FooterComponent } from './components/chrome/footer';
import { GutterContainer } from './components/chrome/gutter-container';
import type { MoonLoader, SpinnerStyle } from './components/chrome/moon-loader';
import { NotifyPanelComponent } from './components/chrome/notify-panel';
import { QueuePaneComponent } from './components/panes/queue-pane';
import type { SessionRow } from './components/dialogs/session-picker';
import { CustomEditor } from './components/editor/custom-editor';
import { DEFAULT_MARKDOWN_CONFIG, DEFAULT_TUI_CONFIG } from './config';
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
  transcriptContainer: GutterContainer;
  activityContainer: Container;
  notifyPanelContainer: Container;
  notifyPanel: NotifyPanelComponent;
  queueContainer: Container;
  queuePane: QueuePaneComponent;
  btwPanelContainer: Container;
  surveyContainer: Container;
  editorContainer: Container;
  /**
   * Fullscreen mode only: the bottom dock (activity/todo/notify/queue/btw/editor +
   * footer) stacked under the transcript ScrollView. Undefined in regular
   * mode, where all chrome is a direct child of the root container.
   */
  dockContainer: VStack | undefined;
  /**
   * Fullscreen mode only: the dock slot holding either `editorContainer` (the
   * editor or a panel standing in for it) or a docked section such as the
   * approval panel, which must join the layout itself to scroll. See
   * {@link setEditorSlot}.
   */
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
  toolOutputExpanded: boolean;
  sessions: SessionRow[];
  loadingSessions: boolean;
  /** Keyset cursor for the next older page; `undefined` when the listing is exhausted. */
  sessionsNextCursor: string | undefined;
  /** A follow-up session page fetch is in flight. */
  sessionsLoadingMore: boolean;
  sessionsScope: 'cwd' | 'all';
  activeDialog:
    | 'session-picker'
    | 'help'
    | 'trust-prompt'
    | 'cache-hint'
    | 'model-switch-confirm'
    | 'goal-start'
    | null;
  /**
   * True while an editor-replacement panel (help, trust prompt, goal queue
   * manager, …) is mounted in place of the editor. Delayed input restores
   * must not run in that state — they would displace the newer panel.
   */
  editorReplacementMounted: boolean;
  tasksBrowser: TasksBrowserState | undefined;
  externalEditorRunning: boolean;
  queuedMessages: QueuedMessage[];
  /**
   * True while a queued user message has been shifted out of
   * {@link queuedMessages} but its deferred send has not run yet. The queue
   * looks empty during this window, so queued-goal promotion must also check
   * this flag to avoid starting a goal ahead of the user's earlier message.
   */
  queuedMessageDispatchPending: boolean;
  swarmModeEntry: 'manual' | 'task' | undefined;
}

export function createTUIState(options: KimiTUIOptions): TUIState {
  const initialAppState = options.initialAppState;
  const theme = currentTheme;

  const terminal = new ProcessTerminal();
  setMarkdownRenderLatex(initialAppState.renderLatex ?? DEFAULT_TUI_CONFIG.renderLatex ?? true);
  setMarkdownMermaidMode(initialAppState.markdown?.mermaid ?? DEFAULT_MARKDOWN_CONFIG.mermaid);
  const fullscreen = initialAppState.tuiMode === 'fullscreen';
  const ui = fullscreen
      ? new TuiAltScreen(terminal, undefined, undefined, {
          // Mouse capture takes over the terminal's native link activation, so
          // route OSC 8 clicks through our own opener.
          openUrl,
          refocusMouseGuardMs: CLICK_GUARD_MS,
          // Likewise, on Windows the terminal's native right-click paste is
          // intercepted; feed the clipboard to the focused component as a
          // bracketed paste instead (renderer only calls this on win32).
          onRightClickPaste: () => {
            const target = ui.getFocusedComponent();
            if (!target?.handleInput || clipboard?.getText === undefined) return;
            void clipboard
              .getText()
              .then((text) => {
                if (!text || ui.getFocusedComponent() !== target) return;
                target.handleInput?.(`\u001B[200~${text}\u001B[201~`);
                ui.requestRender();
              })
              .catch(() => {});
          },
          // Clickable pill centered on the transcript's last row while it is
          // scrolled away from the end.
          scrollToEndIndicator: () => currentTheme.fg('primary', ' ↓ Jump to bottom '),
        })
      : new TuiMainScreen(terminal);

  setMarkdownAltScreenActive(ui instanceof TuiAltScreen);
  setMarkdownRenderRequester(() => {
    ui.requestRender(true);
  });

  const transcriptContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const activityContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  // Docked panels carry their own gutter, so their fullscreen slot is a
  // layout node rather than a GutterContainer (which the layout treats as one
  // opaque block and could only clip, not scroll).
  const queueContainer = fullscreen ? new VStack() : new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const queuePane = new QueuePaneComponent(fullscreen ? { maxBodyRows: DOCK_QUEUE_ROWS } : undefined);
  const notifyPanelContainer = fullscreen ? new VStack() : new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const notifyPanel = new NotifyPanelComponent(
    fullscreen ? { maxBodyRows: DOCK_UPDATES_ROWS, screenRows: () => ui.terminal.rows } : undefined,
  );
  const btwPanelContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const surveyContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const editorContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const editor = new CustomEditor(ui, {
    disablePasteBurst: initialAppState.disablePasteBurst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
  });
  const footer = new FooterComponent({ ...initialAppState }, () => {
    ui.requestRender();
  });

  let dockContainer: VStack | undefined;
  let editorSlot: VStack | undefined;
  if (ui instanceof TuiAltScreen) {
    // Fullscreen (alternate screen): the transcript scrolls inside the primary
    // ScrollView while the rest of the chrome stays docked at the bottom. The
    // footer joins the dock later via mountFooter().
    // Sizing contract (mirrors pi's interactive layout): the transcript starts
    // from basis 0 and grows; the dock keeps its intrinsic height, with the
    // editor never squeezed below its 3 rows (top border / input / bottom
    // border) and the footer below 1 — otherwise the box outline gets clipped.
    const transcriptView = new TranscriptView(transcriptContainer);
    dockContainer = new VStack();
    dockContainer.addChild(activityContainer, { shrink: 1, minSize: 0 });
    dockContainer.addChild(notifyPanelContainer, { shrink: 1, minSize: 0 });
    // A blocking prompt (approval or question) takes the space of the queue,
    // the btw panel and the footer, so its options stay on screen.
    const unlessBlocked = (): boolean => !isBlockingPromptPending(state);
    dockContainer.addChild(queueContainer, { shrink: 1, minSize: 0, visible: unlessBlocked });
    dockContainer.addChild(btwPanelContainer, { shrink: 1, minSize: 0, visible: unlessBlocked });
    dockContainer.addChild(surveyContainer, { shrink: 0, minSize: 0 });
    editorSlot = new VStack();
    editorSlot.addChild(editorContainer, EDITOR_SLOT_ENTRY);
    dockContainer.addChild(editorSlot, EDITOR_SLOT_ENTRY);
    const root = new VStack();
    root.addChild(transcriptView, { basis: 0, grow: 1, shrink: 1, minSize: 1 });
    root.addChild(dockContainer, { basis: 'auto', grow: 0, shrink: 1, minSize: 1 });
    ui.setLayoutRoot(root);
    ui.addLayoutEffect(() => {
      if (ui.getLayoutRoot() === root && transcriptView.updateStickyMessage()) ui.requestRender();
    });
  }

  const state: TUIState = {
    ui,
    terminal,
    transcriptContainer,
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
    toolOutputExpanded: false,
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

/**
 * Footer is the only chrome with content before a session is ready, so
 * mounting it at construction lets a stray pre-start render leak it to the
 * terminal — e.g. above the error when resuming a missing session. The host
 * mounts it only once init() succeeds. FooterComponent isn't a Container, so
 * wrap it to pick up the same outer gutter as the panels above.
 */
export function mountFooter(state: TUIState): void {
  const footerWrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  footerWrap.addChild(state.footer);
  const dock = state.dockContainer;
  if (dock === undefined) {
    state.ui.addChild(footerWrap);
    return;
  }
  // Dock sizing contract: the footer may shrink to 1 row under extreme height
  // pressure, and only gives way to a blocking prompt.
  dock.addChild(footerWrap, {
    shrink: 1,
    minSize: 1,
    visible: () => !isBlockingPromptPending(state),
  });
}

// The editor never shrinks below its 3 rows (top border / input / bottom
// border), and neither does whatever stands in for it.
const EDITOR_SLOT_ENTRY = { shrink: 1, minSize: 3 } as const;

/**
 * Show `component` where the editor sits. A docked section (fullscreen) joins
 * the layout directly so its body can scroll; anything else goes through
 * `editorContainer`, which pads it like the rest of the chrome.
 */
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

/** What stands where the editor sits: the editor itself or a panel that replaced it. */
export function editorSlotComponent(
  state: Pick<TUIState, 'editorContainer' | 'editorSlot'>,
): Component | undefined {
  const slotted = state.editorSlot?.children[0];
  return slotted === undefined || slotted === state.editorContainer
    ? state.editorContainer.children[0]
    : slotted;
}

/** An approval, question, or local goal prompt has replaced the editor and waits for the user. */
export function isBlockingPromptPending(state: Pick<TUIState, 'livePane' | 'activeDialog'>): boolean {
  return (
    state.livePane.pendingApproval !== null ||
    state.livePane.pendingQuestion !== null ||
    state.activeDialog === 'goal-start'
  );
}
