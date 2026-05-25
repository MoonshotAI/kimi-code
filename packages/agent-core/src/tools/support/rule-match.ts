import {
  globMatch,
  pathGlobMatch,
  type PermissionPathMatchOptions,
} from './path-glob-match';

const GLOB_LITERAL_SPECIAL = /[\\*?[\]{}()!+@|]/g;

export function literalRulePattern(toolName: string, subject: string): string {
  return `${toolName}(${escapeRuleSubjectLiteral(subject)})`;
}

export function escapeRuleSubjectLiteral(subject: string): string {
  return subject.replace(GLOB_LITERAL_SPECIAL, '\\$&');
}

export function matchesRuleSubject(ruleArgs: string, subject: string): boolean {
  if (ruleArgs.length === 0) return true;
  try {
    return new RegExp(ruleArgs).test(subject);
  } catch {
    return false;
  }
}

export function matchesAnyRuleSubject(ruleArgs: string, subjects: readonly string[]): boolean {
  return subjects.some((subject) => matchesRuleSubject(ruleArgs, subject));
}

export function matchesGlobRuleSubject(ruleArgs: string, subject: string): boolean {
  return matchRuleSubjects(ruleArgs, [subject], (pattern, value) => globMatch(value, pattern));
}

export function matchesAnyPathRuleSubject(
  ruleArgs: string,
  subjects: readonly string[],
  options: {
    readonly pathOptions?: PermissionPathMatchOptions;
    readonly conservativeCaseFold?: boolean;
  } = {},
): boolean {
  return matchRuleSubjects(ruleArgs, subjects, (pattern, value) =>
    pathGlobMatch(value, pattern, {
      pathOptions: options.pathOptions,
      conservativeCaseFold: options.conservativeCaseFold ?? false,
    }),
  );
}

function matchRuleSubjects(
  ruleArgs: string,
  subjects: readonly string[],
  matchesPositivePattern: (pattern: string, subject: string) => boolean,
): boolean {
  if (ruleArgs.length === 0) return true;
  const negated = ruleArgs.startsWith('!');
  const positivePattern = negated ? ruleArgs.slice(1) : ruleArgs;
  const hit = subjects.some((subject) => matchesPositivePattern(positivePattern, subject));
  return negated ? !hit : hit;
}
