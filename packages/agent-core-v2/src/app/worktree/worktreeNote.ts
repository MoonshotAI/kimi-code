export function worktreeNote(sourceRoot: string): string {
  return `This directory is a git worktree, a separate checkout of the repository whose source checkout is \`${sourceRoot}\`. Run commands and edit files here. Do not \`cd\` into the source checkout or change files there. \`git stash\` is shared by every worktree of this repository.`;
}
