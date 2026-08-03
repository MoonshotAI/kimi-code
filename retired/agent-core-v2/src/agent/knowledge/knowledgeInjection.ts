/**
 * `knowledge` domain (L4) — Context injection provider.
 *
 * Registers with IAgentContextInjectorService to automatically inject
 * relevant knowledge base entries as a system-reminder on each new turn.
 * Modeled after GoalInjection.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentKnowledgeService, type KnowledgeSearchResult } from './knowledge';

const MAX_INJECTION_TOKENS = 800;
const MAX_ENTRIES = 5;

export class KnowledgeInjection extends Disposable {
  constructor(
    @IAgentKnowledgeService private readonly knowledge: IAgentKnowledgeService,
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IAgentContextMemoryService private readonly contextMemory: IAgentContextMemoryService,
  ) {
    super();
    this._register(
      dynamicInjector.register('knowledge', ({ isNewTurn }) =>
        isNewTurn ? this.getInjection() : undefined,
      ),
    );
  }

  private getInjection(): string | undefined {
    const signals = this.extractSignals();
    if (!signals.query && !signals.scopePath) return undefined;

    const results = this.knowledge.search(
      signals.query,
      signals.scopePath,
      signals.tags,
      MAX_ENTRIES,
    );

    if (results.length === 0) return undefined;
    return this.formatInjection(results);
  }

  private extractSignals(): { query: string; scopePath?: string; tags: string[] } {
    const history = this.contextMemory.get();
    const tags: string[] = [];

    // Find the last user message for keywords
    let lastUserText = '';
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg?.role === 'user' && msg.content) {
        for (const part of msg.content) {
          if ('text' in part && part.text) {
            lastUserText = part.text;
            break;
          }
        }
        if (lastUserText) break;
      }
    }

    // Extract keywords (first 200 chars, split on whitespace)
    const words = lastUserText
      .slice(0, 200)
      .replace(/[`"'()[\]{}]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2);
    const query = words.slice(0, 8).join(' ');

    // Detect scope from mentioned file paths
    let scopePath: string | undefined;
    const pathMatch = lastUserText.match(/(?:[\w./\\-]+\.(?:ts|js|rs|vue|tsx|jsx|json|md))/);
    if (pathMatch) scopePath = pathMatch[0];

    // Detect tags from file extensions mentioned
    if (lastUserText.includes('.ts') || lastUserText.includes('typescript')) tags.push('typescript');
    if (lastUserText.includes('.rs') || lastUserText.includes('rust')) tags.push('rust');
    if (lastUserText.includes('test')) tags.push('testing');
    if (lastUserText.includes('import')) tags.push('import');

    return { query, scopePath, tags: [...new Set(tags)] };
  }

  private formatInjection(results: KnowledgeSearchResult[]): string {
    const lines: string[] = ['[Knowledge Base — Relevant Standards]', ''];
    let tokensUsed = 10;

    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const firstLine = r.entry.content.split('\n')[0] ?? '';
      const line = `${i + 1}. [${r.entry.category}] ${r.entry.title}\n   ${firstLine}`;
      const lineTokens = Math.ceil(line.length / 4);
      if (tokensUsed + lineTokens > MAX_INJECTION_TOKENS) break;
      lines.push(line, '');
      tokensUsed += lineTokens;
    }

    return lines.join('\n');
  }
}
