interface SlashMenuCallbacks {
  select: (name: string) => void;
  complete: (name: string) => void;
}

export function dispatchSlashMenuCommand(
  key: "Tab" | "Enter",
  commandName: string,
  callbacks: SlashMenuCallbacks,
): void {
  if (key === "Tab") callbacks.complete(commandName);
  else callbacks.select(commandName);
}
