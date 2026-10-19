interface InsertMentionParams {
  text: string;
  cursorPos: number;
  filePath: string;
  activeToken: { start: number } | null;
  isAppend: boolean;
}

interface InsertMentionResult {
  newText: string;
  newCursorPos: number;
}

export function computeMentionInsert(params: InsertMentionParams): InsertMentionResult {
  const { text, cursorPos, filePath, activeToken, isAppend } = params;
  // Quote paths containing spaces, as the CLI/TUI mention completers do, so
  // whitespace cannot split the mention.
  const target = filePath.includes(" ") ? `"${filePath}"` : filePath;

  if (isAppend || !activeToken) {
    const newText = text + `@${target} `;
    return { newText, newCursorPos: newText.length };
  }

  const before = text.slice(0, activeToken.start);
  const after = text.slice(cursorPos);
  const newText = `${before}@${target} ${after}`;
  const newCursorPos = activeToken.start + 1 + target.length + 1;

  return { newText, newCursorPos };
}
