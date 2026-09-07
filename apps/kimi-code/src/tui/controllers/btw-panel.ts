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
import { formatErrorMessage } from '../utils/event-payload';
import { formatHookResultPlain } from '../utils/hook-result-format';
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
}

export class BtwPanelController {
  private active:
    | {
        readonly agentId: string;
        readonly panel: BtwPanelComponent;
      }
    | undefined;
  private readonly panelsByAgentId = new Map<string, BtwPanelComponent>();

  constructor(private readonly host: BtwPanelHost) {}

  open(
    agentId: string,
    initialPrompt: string,
    inlineSkillActivations?: readonly InlineSkillActivation[],
  ): void {
    let panel: BtwPanelComponent;
    panel = new BtwPanelComponent({
      markdownTheme: createMarkdownTheme(),
      canUseScrollKeys: () => this.host.state.editor.getText().length === 0,
      terminalRows: () => this.host.state.terminal.rows,
      onPrompt: (prompt, inlineSkillActivations) => {
        this.promptAgent(agentId, prompt, panel, inlineSkillActivations);
      },
    });
    this.active = { agentId, panel };
    this.panelsByAgentId.set(agentId, panel);
    this.mount(panel);
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
    this.host.state.editor.connectedAbove = false;
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

  sendUserInput(text: string, inlineSkillActivations?: readonly InlineSkillActivation[]): boolean {
    const active = this.active;
    if (active === undefined) return false;
    if (active.panel.isRunning()) {
      this.showBusyNotice(active, text);
      return true;
    }
    active.panel.submit(text, inlineSkillActivations);
    this.host.state.ui.setFocus(this.host.state.editor);
    this.host.state.ui.requestRender();
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

  private mount(panel: BtwPanelComponent): void {
    this.host.state.btwPanelContainer.clear();
    this.host.state.btwPanelContainer.addChild(new Spacer(1));
    this.host.state.btwPanelContainer.addChild(panel);
    this.host.state.editor.connectedAbove = true;
    this.host.state.ui.setFocus(this.host.state.editor);
    this.host.state.ui.requestRender();
  }

  private close(panel: BtwPanelComponent): void {
    if (!this.host.state.btwPanelContainer.children.includes(panel)) return;
    this.unregister(panel);
    this.host.state.btwPanelContainer.clear();
    this.host.state.editor.connectedAbove = false;
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

  private showBusyNotice(
    active: { readonly panel: BtwPanelComponent },
    input: string,
  ): void {
    this.host.state.editor.setText(input);
    active.panel.addTransientNotice(BTW_BUSY_NOTICE);
    this.host.state.ui.requestRender();
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
