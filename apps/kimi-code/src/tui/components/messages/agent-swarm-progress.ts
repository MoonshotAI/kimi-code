import {
  SwarmProgressComponent,
  type SwarmProgressOptions,
  agentSwarmDescriptionFromArgs,
  agentSwarmItemsFromArgs,
  agentSwarmPartialItemsFromArguments,
  agentSwarmPartialPromptTemplateFromArguments,
  agentSwarmPartialResumeItemsFromArguments,
  agentSwarmPromptTemplateFromArgs,
  agentSwarmResumeItemsFromArgs,
  agentSwarmWorkItemsStartedFromArguments,
} from './swarm-progress';

export interface AgentSwarmProgressOptions extends Omit<SwarmProgressOptions, 'title'> {
  readonly description: string;
}

export class AgentSwarmProgressComponent extends SwarmProgressComponent {
  constructor(options: AgentSwarmProgressOptions) {
    super({
      ...options,
      title: 'Agent Swarm',
    });
  }

  override updateArgs(
    args: Record<string, unknown>,
    options: { readonly streamingArguments?: string | undefined } = {},
  ): void {
    const streamingArguments = options.streamingArguments;
    this.updateDescription(agentSwarmDescriptionFromArgs(args));
    const fullRows = [...agentSwarmResumeItemsFromArgs(args), ...agentSwarmItemsFromArgs(args)];
    const partialRows = streamingArguments === undefined
      ? []
      : [
          ...agentSwarmPartialResumeItemsFromArguments(streamingArguments),
          ...agentSwarmPartialItemsFromArguments(streamingArguments),
        ];
    if (
      fullRows.length > 0 ||
      partialRows.length > 0 ||
      (streamingArguments !== undefined && agentSwarmWorkItemsStartedFromArguments(streamingArguments))
    ) {
      this.markItemsStarted();
    }

    const fullPromptTemplate = agentSwarmPromptTemplateFromArgs(args);
    const partialPromptTemplate =
      streamingArguments === undefined
        ? ''
        : agentSwarmPartialPromptTemplateFromArguments(streamingArguments);
    const promptTemplate =
      fullPromptTemplate.length > 0 ? fullPromptTemplate : partialPromptTemplate;
    this.setPromptTemplateText(promptTemplate);

    const itemCount = Math.max(fullRows.length, partialRows.length);
    if (itemCount > 0) this.setMemberCount(itemCount);
    this.setMemberItemTexts(fullRows, partialRows);
  }
}

export {
  agentSwarmDescriptionFromArgs,
  agentSwarmGridHeightForTerminalRows,
  agentSwarmItemsFromArgs,
  agentSwarmPartialItemsCountFromArguments,
  agentSwarmPartialItemsFromArguments,
  agentSwarmResultSummaryFromOutput,
  calculateAgentSwarmGridLayout,
  type AgentSwarmGridLayout,
  type AgentSwarmGridLayoutInput,
  type AgentSwarmResultSummary,
} from './swarm-progress';
