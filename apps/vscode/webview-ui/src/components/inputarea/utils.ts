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

  if (isAppend || !activeToken) {
    const newText = text + `@${filePath} `;
    return { newText, newCursorPos: newText.length };
  }

  const before = text.slice(0, activeToken.start);
  const after = text.slice(cursorPos);
  const newText = `${before}@${filePath} ${after}`;
  const newCursorPos = activeToken.start + 1 + filePath.length + 1;

  return { newText, newCursorPos };
}
