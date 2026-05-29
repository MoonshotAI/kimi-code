import { DynamicInjector } from './injector';

/**
 * Surfaces an up-to-date skill listing when plugins are hot-loaded mid-session.
 *
 * The base system prompt bakes in the skill listing once at bootstrap and is
 * intentionally NOT rewritten on `/plugins reload` — rewriting it would bust the
 * prompt-cache prefix for the whole conversation and reset runtime state. Instead
 * this injector appends the current listing as a system reminder. The listing's
 * "DISREGARD any earlier skill listings" header makes it supersede the stale one
 * still sitting in the prompt. The base class re-injects after compaction scrolls
 * the reminder out, so the model never loses the up-to-date listing.
 */
export class SkillRefreshInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'skills_reloaded';
  private surfaced: string | undefined;

  override onContextClear(): void {
    super.onContextClear();
    this.surfaced = undefined;
  }

  override getInjection(): string | undefined {
    const registry = this.agent.skills?.registry;
    if (registry === undefined) return undefined;
    // No baseline captured means the agent never rendered a profile prompt with
    // a skill listing (e.g. a resumed agent replaying its prompt, or a bare test
    // agent). Without a baseline we cannot tell what the model already sees, so
    // surface nothing rather than risk a spurious reminder.
    const baseline = this.agent.systemPromptSkillListing;
    if (baseline === undefined) return undefined;
    const current = registry.getModelSkillListing();
    // While the live listing still matches the one baked into the system
    // prompt, there is nothing extra to surface.
    if (current === baseline) return undefined;
    // The listing drifted from the prompt baseline. Surface it once; only
    // re-surface if it changed again or scrolled out of context via compaction
    // (the base class nulls `injectedAt` in that case).
    if (this.injectedAt !== null && this.surfaced === current) return undefined;
    this.surfaced = current;
    return current;
  }
}
