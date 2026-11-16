export function substituteArtexGoal(template: string, goal: string): string {
  if (!template.includes('{{.Goal}}')) return template;
  const trimmed = goal.trim();
  return template.replaceAll('{{.Goal}}', trimmed.length > 0 ? trimmed : '(unspecified)');
}