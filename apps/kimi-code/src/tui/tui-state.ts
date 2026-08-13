import {
  Container,
  ProcessTerminal,
  ScrollView,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  type TUI,
} from '@moonshot-ai/pi-tui';

import { clipboard } from '#/utils/clipboard/clipboard-native';
import { openUrl } from '#/utils/open-url';

import { FooterComponent } from './components/chrome/footer';import { GutterContainer } from './components/chrome/gutter-container';
import type { MoonLoader, SpinnerStyle } from './components/chrome/moon-loader';
import { TodoPanelComponent } from './components/chrome/todo-panel';
import type { SessionRow } from './components/dialogs/session-picker';
import { CustomEditor } from './components/editor/custom-editor';
import { DEFAULT_TUI_CONFIG } from './config';
import { CHROME_GUTTER } from './constant/rendering';
import type { TasksBrowserState } from './controllers/tasks-browser';
import { currentTheme, type Theme } from './theme';
import { setMarkdownRenderLatex } from './utils/markdown-options';
import { createTerminalState, type TerminalState } from './utils/terminal-state';
import {
  INITIAL_LIVE_PANE,
  type AppState,
  type KimiTUIOptions,
  type LivePaneState,
  type QueuedMessage,
  type TranscriptEntry,
  type TUIStartupState,
} from './types';

export interface TUIState {
  ui: TUI;
  terminal: ProcessTerminal;
  transcriptContainer: Container;
  activityContainer: Container;
  todoPanelContainer: Container;
  todoPanel: TodoPanelComponent;
  queueContainer: Container;
  btwPanelContainer: Container;
  editorContainer: Container;
  /**
   * Fullscreen mode only: the bottom dock (activity/todo/queue/btw/editor +
   * footer) stacked under the transcript ScrollView. Undefined in regular
   * mode, where all chrome is a direct child of the root container.
   */
  dockContainer: VStack | undefined;
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
  activeDialog: 'session-picker' | 'help' | 'trust-prompt' | 'cache-hint' | null;
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
  // Fullscreen is experimental and env-gated for now: KIMI_CODE_TUI_FULL_SCREEN=1.
  const fullscreen = process.env['KIMI_CODE_TUI_FULL_SCREEN'] === '1';
  const ui =
    fullscreen
      ? new TuiAltScreen(terminal, undefined, undefined, {
          // Mouse capture takes over the terminal's native link activation, so
          // route OSC 8 clicks through our own opener.
          openUrl,
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
                target.handleInput?.(`\x1b[200~${text}\x1b[201~`);
                ui.requestRender();
              })
              .catch(() => {});
          },
        })
      : new TuiMainScreen(terminal);

  const transcriptContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const activityContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const todoPanelContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const todoPanel = new TodoPanelComponent();
  const queueContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const btwPanelContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const editorContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const editor = new CustomEditor(ui, {
    disablePasteBurst: initialAppState.disablePasteBurst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
  });
  const footer = new FooterComponent({ ...initialAppState }, () => {
    ui.requestRender();
  });

  let dockContainer: VStack | undefined;
  if (ui instanceof TuiAltScreen) {
    // Fullscreen (alternate screen): the transcript scrolls inside the primary
    // ScrollView while the rest of the chrome stays docked at the bottom. The
    // footer joins the dock later via mountFooter().
    // Sizing contract (mirrors pi's interactive layout): the transcript starts
    // from basis 0 and grows; the dock keeps its intrinsic height, with the
    // editor never squeezed below its 3 rows (top border / input / bottom
    // border) and the footer below 1 — otherwise the box outline gets clipped.
    const scrollView = new ScrollView(transcriptContainer, {
      follow: 'end',
      primary: true,
      overscroll: 'chain',
      scrollbar: 'auto',
    });
    dockContainer = new VStack();
    dockContainer.addChild(activityContainer, { shrink: 1, minSize: 0 });
    dockContainer.addChild(todoPanelContainer, { shrink: 1, minSize: 0 });
    dockContainer.addChild(queueContainer, { shrink: 1, minSize: 0 });
    dockContainer.addChild(btwPanelContainer, { shrink: 1, minSize: 0 });
    dockContainer.addChild(editorContainer, { shrink: 1, minSize: 3 });
    const root = new VStack();
    root.addChild(scrollView, { basis: 0, grow: 1, shrink: 1, minSize: 1 });
    root.addChild(dockContainer, { basis: 'auto', grow: 0, shrink: 1, minSize: 1 });
    ui.setLayoutRoot(root);
  }

  return {
    ui,
    terminal,
    transcriptContainer,
    activityContainer,
    todoPanelContainer,
    todoPanel,
    queueContainer,
    btwPanelContainer,
    editorContainer,
    dockContainer,
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
    tasksBrowser: undefined,
    externalEditorRunning: false,
    queuedMessages: [],
    queuedMessageDispatchPending: false,
    swarmModeEntry: undefined,
  };
}
