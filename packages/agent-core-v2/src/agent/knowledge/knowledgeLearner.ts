/**
 * `knowledge` domain (L4) — AI auto-learning service.
 *
 * Subscribes to `turn.ended` events and detects user corrections or
 * pitfall discoveries, then automatically writes them to the knowledge base.
 * Entries created by the learner have confidence=0.7 and source='ai-learned'.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentKnowledgeService } from './knowledge';

/** Patterns that indicate the user is correcting the agent */
const CORRECTION_PATTERNS = [
  /不对[，,]?应该/,
  /错了[，,]?是/,
  /不是.*而是/,
  /应该用.*不是/,
  /用\s*\S+\s*不要用/,
  /别用.*用/,
  /must use|should use|don't use|do not use/i,
  /规范是|标准是|约定是/,
  /记住[：:]/,
  /以后.*要/,
];

export class KnowledgeLearner extends Disposable {
  constructor(
    @IAgentKnowledgeService private readonly knowledge: IAgentKnowledgeService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentContextMemoryService private readonly contextMemory: IAgentContextMemoryService,
  ) {
    super();
    this._register(
      this.eventBus.subscribe('turn.ended', () => this.onTurnEnded()),
    );
  }

  private onTurnEnded(): void {
    const history = this.contextMemory.get();

    // Look at user messages in this turn for correction patterns
    for (let i = history.length - 1; i >= Math.max(0, history.length - 5); i--) {
      const msg = history[i];
      if (msg?.role !== 'user') continue;

      for (const part of msg.content ?? []) {
        if (!('text' in part) || !part.text) continue;
        const text = part.text;

        for (const pattern of CORRECTION_PATTERNS) {
          if (pattern.test(text)) {
            this.learnFromCorrection(text);
            return; // Only learn once per turn
          }
        }
      }
    }
  }

  private learnFromCorrection(text: string): void {
    // Extract a title from the correction (first 60 chars)
    const title = text.slice(0, 60).replace(/[\n\r]/g, ' ').trim();
    if (title.length < 5) return;

    // Detect category
    let category: 'coding-style' | 'pitfall' | 'architecture' | 'workflow' = 'pitfall';
    if (/import|命名|格式|style|naming/i.test(text)) category = 'coding-style';
    if (/架构|设计|依赖|architecture/i.test(text)) category = 'architecture';
    if (/流程|提交|commit|push|workflow/i.test(text)) category = 'workflow';

    // Detect tags from content
    const tags: string[] = [];
    if (/typescript|\.ts/i.test(text)) tags.push('typescript');
    if (/rust|\.rs/i.test(text)) tags.push('rust');
    if (/import/i.test(text)) tags.push('import');
    if (/git|commit|push/i.test(text)) tags.push('git');

    const entry = this.knowledge.add({
      title,
      category,
      content: text,
      tags,
      source: 'ai-learned',
      confidence: 0.7,
    });

    if (entry) {
      // The notification is visible to the user through the agent's context
      // (appended as a brief system note on the next turn)
    }
  }
}
