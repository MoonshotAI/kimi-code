// packages/app-core/src/lib/sessionRecency.ts
// Recency-ordered session pool inserts. The sidebar's ordering contract is
// updatedAt-desc everywhere (flat / grouped / pinned attention tier), so pool
// inserts must land at the timestamp's position — never forced to the front.

/**
 * Insert (or replace, de-duped by id) `session` into an updatedAt-desc pool.
 * ISO timestamps compare lexicographically. A newcomer lands after existing
 * equal timestamps; a same-id replace with an unchanged timestamp keeps its
 * exact slot (an undo/meta touch must not slide a session behind its
 * same-timestamp fork). Position comes from the timestamp alone:
 * restores/forks land at their content time instead of floating to the top.
 */
export function insertSessionByRecency<T extends { id: string; updatedAt: string }>(
  sessions: readonly T[],
  session: T,
): T[] {
  const selfIndex = sessions.findIndex((s) => s.id === session.id);
  if (selfIndex !== -1 && sessions[selfIndex]!.updatedAt === session.updatedAt) {
    return sessions.map((s) => (s.id === session.id ? session : s));
  }
  const rest = sessions.filter((s) => s.id !== session.id);
  const at = rest.findIndex((s) => s.updatedAt < session.updatedAt);
  return at === -1 ? [...rest, session] : [...rest.slice(0, at), session, ...rest.slice(at)];
}
