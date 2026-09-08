import { Spacer } from '@moonshot-ai/pi-tui';
import type {
  Event,
  KimiHarness,
  PromptInput,
  Session,
  TurnEndedEvent,
} from '@moonshot-ai/kimi-code-sdk';

import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { BtwPanelComponent } from '../components/panes/btw-panel';
import { CustomEditor } from '../components/editor/custom-editor';
import { DEFAULT_TUI_CONFIG } from '../config';
import { formatErrorMessage } from '../utils/event-payload';
import { formatHookResultPlain } from '../utils/hook-result-format';
import { extractInlineSkillActivations } from '../utils/inline-skill-tokens';
import { createMarkdownTheme } from '../theme/pi-tui-theme';
import type { InlineSkillActivation } from '../types';
import type { TUIState } from '../tui-state';

import type { StagingLease } from './staging-leases';

const BTW_BUSY_NOTICE = 'Wait for /btw to finish before sending another question.';

export interface BtwPreparedPrompt {
  /** Media-expanded RPC input; undefined means send the plain text prompt. */
  readonly input?: PromptInput;
  /** Staged-media lease and its exact-binding submission id (plain prompts only). */
  readonly lease?: StagingLease;
  readonly submissionId?: string;
}

export interface BtwPanelHost {
  state: TUIState;
  session: Session | undefined;
  readonly harness: KimiHarness;
  readonly skillCommandMap: ReadonlyMap<string, string>;

  showError(msg: string): void;
  /**
   * Expand pasted image/video placeholders into daemon file-ref parts for the
   * side agent (the /btw counterpart of the main send path's media
   * preparation). Returns undefined when preparation failed — the error was
   * already shown.
   */
  prepareBtwPrompt(
    text: string,
    opts: { readonly stage: boolean },
  ): Promise<BtwPreparedPrompt | undefined>;
  /** Track a prompt dispatch carrying staged media; see StagingLeaseTracker.trackDispatch. */
  trackBtwDispatch(
    lease: StagingLease | undefined,
    request: Promise<unknown>,
    onError: (error: unknown) => void,
  ): void;
  /**
   * Paste the clipboard's image/video into the panel's dedicated editor as an
   * imageStore placeholder (the same ingestion path the main editor uses).
   */
  pasteImageIntoEditor(editor: CustomEditor): Promise<boolean>;
}

export class BtwPanelController {
  private active:
    | {
        readonly agentId: string;
        readonly panel: BtwPanelComponent;
        readonly editor: CustomEditor;
      }
    | undefined;
  private readonly panelsByAgentId = new Map<string, BtwPanelComponent>();

  constructor(private readonly host: BtwPanelHost) {}

  open(
    agentId: string,
    initialPrompt: string,
    inlineSkillActivations?: readonly InlineSkillActivation[],
  ): void {
    // The panel owns a dedicated editor instance — the same CustomEditor
    // component class as the main input, but trimmed to plain prompts plus
    // file/image paste: no queue, no steer, no bash mode, no slash-command
    // autocomplete, no history. Esc/↑↓/Ctrl+C keep the panel semantics.
    const editor = new CustomEditor(this.host.state.ui, {
      disablePasteBurst:
        this.host.state.appState.disablePasteBurst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
      disableBashMode: true,
    });
    const panel = new BtwPanelComponent({
      markdownTheme: createMarkdownTheme(),
      canUseScrollKeys: () =>
        this.host.state.editor.getText().length === 0 && editor.getText().length === 0,
      terminalRows: () => this.host.state.terminal.rows,
      onPrompt: (prompt, inlineSkillActivations) => {
        this.promptAgent(agentId, prompt, panel, inlineSkillActivations);
      },
    });
    this.wireEditor(panel, editor);
    this.active = { agentId, panel, editor };
    this.panelsByAgentId.set(agentId, panel);
    this.mount(panel, editor);
    panel.submit(initialPrompt, inlineSkillActivations);
  }

  isActive(): boolean {
    return this.active !== undefined;
  }

  clear(): void {
    const active = this.active;
    if (active !== undefined && this.shouldCancelOnUnmount(active.panel)) {
      void this.cancelAgent(active.agentId);
    }
    this.active = undefined;
    this.panelsByAgentId.clear();
    this.host.state.btwPanelContainer.clear();
    // The panel's editor is gone with the container; never leave focus on a
    // detached component.
    if (active !== undefined && active.editor.focused) {
      this.host.state.ui.setFocus(this.host.state.editor);
    }
  }

  closeOrCancel(): boolean {
    const active = this.active;
    if (active === undefined) return false;
    const shouldCancel = this.shouldCancelOnUnmount(active.panel);
    this.close(active.panel);
    if (shouldCancel) {
      void this.cancelAgent(active.agentId);
    }
    return true;
  }

  cancelRunning(): boolean {
    const active = this.active;
    if (active === undefined || !active.panel.isRunning()) return false;
    void this.cancelAgent(active.agentId);
    return true;
  }

  scroll(direction: 'up' | 'down'): boolean {
    const panel = this.active?.panel;
    if (panel === undefined || !panel.scroll(direction)) return false;
    this.host.state.ui.requestRender();
    return true;
  }

  routeEvent(event: Event): boolean {
    const panel = this.panelsByAgentId.get(event.agentId);
    if (panel === undefined) return false;

    switch (event.type) {
      case 'assistant.delta':
        panel.appendAnswer(event.delta);
        this.host.state.ui.requestRender();
        return true;
      case 'thinking.delta':
        panel.appendThinking(event.delta);
        this.host.state.ui.requestRender();
        return true;
      case 'hook.result':
        panel.appendAnswer(formatHookResultPlain(event));
        this.host.state.ui.requestRender();
        return true;
      case 'turn.ended':
        if (event.reason === 'completed') {
          panel.markDone();
        } else {
          panel.markFailed(formatBtwTurnEnd(event));
        }
        this.host.state.ui.requestRender();
        return true;
      default:
        return true;
    }
  }

  /**
   * Wire the panel's dedicated editor. Only the panel-relevant bindings are
   * set: submit routes straight to the side agent (never through the main
   * send path's queue/steer interception), Esc closes, ↑↓ scroll the panel,
   * Ctrl+C cancels/closes, and image paste lands as imageStore placeholders.
   */
  private wireEditor(panel: BtwPanelComponent, editor: CustomEditor): void {
    editor.onSubmit = (text) => {
      if (text.trim().length === 0) return;
      if (panel.isRunning()) {
        // One side question at a time: restore the submitted draft and point
        // at the in-flight turn instead of dropping the input.
        editor.setText(text);
        panel.addTransientNotice(BTW_BUSY_NOTICE);
        this.host.state.ui.requestRender();
        return;
      }
      const activations = extractInlineSkillActivations(text, this.host.skillCommandMap);
      panel.submit(text, activations.length > 0 ? activations : undefined);
      this.host.state.ui.requestRender();
    };
    editor.onEscape = () => {
      this.closeOrCancel();
    };
    editor.onCtrlC = () => {
      if (!this.cancelRunning()) {
        this.closeOrCancel();
      }
    };
    editor.onUpArrowEmpty = () => this.scroll('up');
    editor.onDownArrowEmpty = () => this.scroll('down');
    editor.onPasteImage = () => this.host.pasteImageIntoEditor(editor);
  }

  private mount(panel: BtwPanelComponent, editor: CustomEditor): void {
    this.host.state.btwPanelContainer.clear();
    this.host.state.btwPanelContainer.addChild(new Spacer(1));
    this.host.state.btwPanelContainer.addChild(panel);
    // The panel renders an open bottom edge; the editor's connected top
    // border stitches the two into one box, exactly like the main editor
    // used to when it doubled as the panel's input.
    editor.connectedAbove = true;
    this.host.state.btwPanelContainer.addChild(editor);
    this.host.state.ui.setFocus(editor);
    this.host.state.ui.requestRender();
  }

  private close(panel: BtwPanelComponent): void {
    if (!this.host.state.btwPanelContainer.children.includes(panel)) return;
    this.unregister(panel);
    this.host.state.btwPanelContainer.clear();
    this.host.state.ui.setFocus(this.host.state.editor);
    this.host.state.ui.requestRender(true);
  }

  private unregister(panel: BtwPanelComponent): void {
    for (const [agentId, candidate] of this.panelsByAgentId) {
      if (candidate === panel) {
        this.panelsByAgentId.delete(agentId);
      }
    }
    if (this.active?.panel === panel) this.active = undefined;
  }

  private promptAgent(
    agentId: string,
    prompt: string,
    panel: BtwPanelComponent,
    inlineSkillActivations?: readonly InlineSkillActivation[],
  ): void {
    void this.prepareAndPrompt(agentId, prompt, panel, inlineSkillActivations);
  }

  private async prepareAndPrompt(
    agentId: string,
    prompt: string,
    panel: BtwPanelComponent,
    inlineSkillActivations?: readonly InlineSkillActivation[],
  ): Promise<void> {
    const session = this.host.session;
    if (session === undefined) {
      panel.markFailed(NO_ACTIVE_SESSION_MESSAGE);
      this.host.state.ui.requestRender();
      return;
    }
    const useSkills = inlineSkillActivations !== undefined && inlineSkillActivations.length > 0;
    // Skill bundles have no prompt-id channel, so they match the main turn's
    // inline-skill path: media rides along without a staged lease.
    const prepared = await this.host.prepareBtwPrompt(prompt, { stage: !useSkills });
    if (prepared === undefined) {
      panel.markFailed('Failed to prepare the media attachment.');
      this.host.state.ui.requestRender();
      return;
    }
    const input = prepared.input ?? prompt;
    const send = useSkills
      ? () =>
          session.promptWithSkills(
            input,
            inlineSkillActivations.map((activation) => ({
              name: activation.skillName,
              args: activation.args,
            })),
          )
      : prepared.submissionId !== undefined
        ? () => session.prompt(input, { promptId: prepared.submissionId })
        : () => session.prompt(input);
    this.host.trackBtwDispatch(
      prepared.lease,
      this.withInteractiveAgent(agentId, send),
      (error: unknown) => {
        panel.markFailed(`Failed to send /btw prompt: ${formatErrorMessage(error)}`);
        this.host.state.ui.requestRender();
      },
    );
  }

  private async cancelAgent(agentId: string): Promise<void> {
    const session = this.host.session;
    if (session === undefined) return;
    await this.withInteractiveAgent(agentId, () => session.cancel()).catch((error: unknown) => {
      this.host.showError(`Failed to cancel /btw: ${formatErrorMessage(error)}`);
    });
  }

  private shouldCancelOnUnmount(panel: BtwPanelComponent): boolean {
    return panel.isRunning() || panel.isEmpty();
  }

  private withInteractiveAgent<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    return this.host.harness.withInteractiveAgent(agentId, fn);
  }
}

function formatBtwTurnEnd(event: TurnEndedEvent): string {
  if (event.reason === 'cancelled') {
    return 'Interrupted by user';
  }
  if (event.error?.code === 'provider.filtered') {
    return 'Provider safety policy blocked the response.';
  }
  if (event.error !== undefined) {
    return `[${event.error.code}] ${event.error.message}`;
  }
  if (event.reason === 'blocked') {
    return 'Prompt hook blocked the request.';
  }
  return `BTW turn ended with reason: ${event.reason}`;
}
