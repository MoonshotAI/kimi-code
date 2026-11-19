
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
