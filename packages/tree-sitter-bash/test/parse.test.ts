import { describe, expect, it } from 'vitest';

import { Aborted, ParseBudget } from '#/budget';
import type { SyntaxNode } from '#/node';
import { descendantsOfType } from '#/node';
import { parse } from '#/parse';

/** Compact S-expression of the tree: named leaves are (type "text"),
 *  anonymous leaves are just their quoted type, inner nodes nest. */
function sexp(node: SyntaxNode): string {
  if (node.children.length === 0) {
    return node.isNamed ? `(${node.type} ${JSON.stringify(node.text)})` : JSON.stringify(node.type);
  }
  const label = node.isNamed ? node.type : JSON.stringify(node.type);
  return `(${label} ${node.children.map(sexp).join(' ')})`;
}

function parseOk(source: string): { rootNode: SyntaxNode; hasError: boolean } {
  const result = parse(source);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  return result;
}

/** Parse and assert the exact tree shape plus the hasError flag. */
function expectTree(source: string, expected: string, hasError = false): SyntaxNode {
  const { rootNode, hasError: actual } = parseOk(source);
  expect(actual).toBe(hasError);
  expect(sexp(rootNode)).toBe(expected);
  return rootNode;
}

describe('ParseBudget', () => {
  it('counts nodes and stays under the cap', () => {
    const budget = new ParseBudget({ timeoutMs: 60_000, maxNodes: 3 });
    budget.tick();
    budget.tick();
    expect(budget.nodesUsed).toBe(2);
  });

  it('throws Aborted when the node cap is exceeded', () => {
    const budget = new ParseBudget({ timeoutMs: 60_000, maxNodes: 1 });
    budget.tick();
    expect(() => {
      budget.tick();
    }).toThrow(Aborted);
  });

  it('throws Aborted once the deadline is reached', () => {
    const budget = new ParseBudget({ timeoutMs: 0, maxNodes: 1_000 });
    expect(() => {
      budget.tick();
    }).toThrow(Aborted);
  });

  it('applies documented defaults', () => {
    const budget = new ParseBudget();
    // Default node cap is 50_000: the 50_000th node is still allowed.
    for (let i = 0; i < 50_000; i++) budget.tick();
    expect(() => {
      budget.tick();
    }).toThrow(Aborted);
  });
});

describe('parse entry contract', () => {
  it('parses an empty source into an empty program', () => {
    const { rootNode, hasError } = parseOk('');
    expect(rootNode.type).toBe('program');
    expect(rootNode.text).toBe('');
    expect(rootNode.children).toHaveLength(0);
    expect(hasError).toBe(false);
  });

  it('returns { ok: false, reason: "aborted" } when the node budget is exceeded', () => {
    expect(parse('echo hello', { timeoutMs: 60_000, maxNodes: 1 })).toEqual({ ok: false, reason: 'aborted' });
  });

  it('returns { ok: false, reason: "aborted" } when the deadline has passed', () => {
    expect(parse('echo hello', { timeoutMs: 0 })).toEqual({ ok: false, reason: 'aborted' });
  });

  it('aborts instead of hanging on tens of thousands of statements', () => {
    expect(parse('ls; '.repeat(20_000))).toEqual({ ok: false, reason: 'aborted' });
  });
});

describe('simple commands', () => {
  it('parses a command with arguments', () => {
    expectTree('ls -la', `(program (command (command_name (word "ls")) (word "-la")))`);
  });

  it('parses double-quoted strings with expansions and raw strings', () => {
    expectTree(
      `echo "hello $NAME" 'raw'`,
      `(program (command (command_name (word "echo")) (string "\\"" (string_content "hello ") (simple_expansion "$" (variable_name "NAME")) "\\"") (raw_string "'raw'")))`,
    );
  });

  it('parses a pipeline inside && / || lists, left associative', () => {
    expectTree(
      'FOO=bar env | grep FOO && echo ok || echo fail',
      `(program (list (list (pipeline (command (variable_assignment (variable_name "FOO") "=" (word "bar")) (command_name (word "env"))) "|" (command (command_name (word "grep")) (word "FOO"))) "&&" (command (command_name (word "echo")) (word "ok"))) "||" (command (command_name (word "echo")) (word "fail"))))`,
    );
  });

  it('parses ! as negated_command', () => {
    expectTree(
      '! grep -q x file',
      `(program (negated_command "!" (command (command_name (word "grep")) (word "-q") (word "x") (word "file"))))`,
    );
  });

  it('attaches comments as named children', () => {
    expectTree(
      '# a comment\necho hi # trailing',
      `(program (comment "# a comment") "\\n" (command (command_name (word "echo")) (word "hi")) (comment "# trailing"))`,
    );
  });

  it('distinguishes number from word', () => {
    expectTree(
      'echo 123 45.6',
      `(program (command (command_name (word "echo")) (number "123") (word "45.6")))`,
    );
  });

  it('parses concatenations of adjacent pieces', () => {
    expectTree(
      `echo a"b"c'd'$e\${f}g`,
      `(program (command (command_name (word "echo")) (concatenation (word "a") (string "\\"" (string_content "b") "\\"") (word "c") (raw_string "'d'") (simple_expansion "$" (variable_name "e")) (expansion "\${" (variable_name "f") "}") (word "g"))))`,
    );
  });

  it('splits { } into single-character word pieces', () => {
    expectTree(
      'echo {a,b}',
      `(program (command (command_name (word "echo")) (concatenation (word "{") (word "a,b") (word "}"))))`,
    );
  });

  it('treats a lone $ as an anonymous argument', () => {
    expectTree('echo $', `(program (command (command_name (word "echo")) "$"))`);
  });
});

describe('expansions and substitutions', () => {
  it('parses backtick and $() command substitutions', () => {
    expectTree(
      'echo `hostname` $(date)',
      `(program (command (command_name (word "echo")) (command_substitution "\`" (command (command_name (word "hostname"))) "\`") (command_substitution "$(" (command (command_name (word "date"))) ")")))`,
    );
  });

  it('parses nested command substitutions recursively', () => {
    expectTree(
      'echo $(a $(b c))',
      `(program (command (command_name (word "echo")) (command_substitution "$(" (command (command_name (word "a")) (command_substitution "$(" (command (command_name (word "b")) (word "c")) ")")) ")")))`,
    );
  });

  it('parses ${...} expansions with operators and defaults', () => {
    expectTree(
      'echo ${v:-d} ${x} $1 $@',
      `(program (command (command_name (word "echo")) (expansion "\${" (variable_name "v") ":-" (word "d") "}") (expansion "\${" (variable_name "x") "}") (simple_expansion "$" (variable_name "1")) (simple_expansion "$" (special_variable_name "@"))))`,
    );
  });

  it('parses ${#v}, ${v:=word} and ${a[0]}', () => {
    expectTree('echo ${#v}', `(program (command (command_name (word "echo")) (expansion "\${" "#" (variable_name "v") "}")))`);
    expectTree(
      'echo ${v:=word}',
      `(program (command (command_name (word "echo")) (expansion "\${" (variable_name "v") ":=" (word "word") "}")))`,
    );
    expectTree(
      'echo ${a[0]}',
      `(program (command (command_name (word "echo")) (expansion "\${" (subscript (variable_name "a") "[" (number "0") "]") "}")))`,
    );
  });

  it('parses expansions nested inside expansions', () => {
    expectTree(
      'echo ${v:-$(cmd)}',
      `(program (command (command_name (word "echo")) (expansion "\${" (variable_name "v") ":-" (command_substitution "$(" (command (command_name (word "cmd"))) ")") "}")))`,
    );
  });

  it('parses process substitutions', () => {
    expectTree(
      'diff <(cmd) >(other)',
      `(program (command (command_name (word "diff")) (process_substitution "<(" (command (command_name (word "cmd"))) ")") (process_substitution ">(" (command (command_name (word "other"))) ")")))`,
    );
  });

  it('parses $((...)) as an arithmetic_expansion placeholder (TODO(M2))', () => {
    expectTree(
      'echo $((1<<2))',
      `(program (command (command_name (word "echo")) (arithmetic_expansion "$((" (word "1<<2") "))")))`,
    );
  });
});

describe('redirects', () => {
  it('parses output redirect and fd duplication', () => {
    expectTree(
      'cmd > out 2>&1',
      `(program (redirected_statement (command (command_name (word "cmd"))) (file_redirect ">" (word "out")) (file_redirect (file_descriptor "2") ">&" (number "1"))))`,
    );
  });

  it('parses &>> appending both streams', () => {
    expectTree(
      'cmd &>> log',
      `(program (redirected_statement (command (command_name (word "cmd"))) (file_redirect "&>>" (word "log"))))`,
    );
  });

  it('parses <> read-write redirect with a file descriptor', () => {
    expectTree(
      'exec 3<>file',
      `(program (redirected_statement (command (command_name (word "exec"))) (file_redirect (file_descriptor "3") "<>" (word "file"))))`,
    );
  });

  it('parses >|, <&-, < and fd redirects', () => {
    expectTree(
      'cmd >| file',
      `(program (redirected_statement (command (command_name (word "cmd"))) (file_redirect ">|" (word "file"))))`,
    );
    expectTree('cmd >&-', `(program (redirected_statement (command (command_name (word "cmd"))) (file_redirect ">&-")))`);
    expectTree(
      'cmd < in',
      `(program (redirected_statement (command (command_name (word "cmd"))) (file_redirect "<" (word "in"))))`,
    );
    expectTree(
      'cmd 2>/dev/null',
      `(program (redirected_statement (command (command_name (word "cmd"))) (file_redirect (file_descriptor "2") ">" (word "/dev/null"))))`,
    );
  });

  it('keeps a herestring inside the command node', () => {
    expectTree(
      'cmd <<< "$str"',
      `(program (command (command_name (word "cmd")) (herestring_redirect "<<<" (string "\\"" (simple_expansion "$" (variable_name "str")) "\\""))))`,
    );
  });

  it('wraps a command carrying both a herestring and a file redirect', () => {
    expectTree(
      'cmd <<< x > out',
      `(program (redirected_statement (command (command_name (word "cmd")) (herestring_redirect "<<<" (word "x"))) (file_redirect ">" (word "out"))))`,
    );
  });

  it('parses a redirect-only statement', () => {
    expectTree('> out', `(program (redirected_statement (file_redirect ">" (word "out"))))`);
  });

  it('keeps a prefix redirect inside the command', () => {
    expectTree(
      '> a cmd x',
      `(program (command (file_redirect ">" (word "a")) (command_name (word "cmd")) (word "x")))`,
    );
  });

  it('wraps subshells and negated commands with their redirects', () => {
    expectTree(
      '(ls) > out',
      `(program (redirected_statement (subshell "(" (command (command_name (word "ls"))) ")") (file_redirect ">" (word "out"))))`,
    );
    expectTree(
      '! ls > out',
      `(program (redirected_statement (negated_command "!" (command (command_name (word "ls")))) (file_redirect ">" (word "out"))))`,
    );
  });
});

describe('heredocs', () => {
  it('parses a heredoc with expansions in the body', () => {
    expectTree(
      'cat <<EOF\nhello $USER\nEOF',
      `(program (redirected_statement (command (command_name (word "cat"))) (heredoc_redirect "<<" (heredoc_start "EOF") (heredoc_body (heredoc_content "hello ") (simple_expansion "$" (variable_name "USER")) (heredoc_content "\\n")) (heredoc_end "EOF"))))`,
    );
  });

  it('strips first-line tabs for <<- and keeps the marker indented', () => {
    expectTree(
      'cat <<-EOF\n\tindented\n\tEOF',
      `(program (redirected_statement (command (command_name (word "cat"))) (heredoc_redirect "<<-" (heredoc_start "EOF") (heredoc_body (heredoc_content "indented\\n\\t")) (heredoc_end "EOF"))))`,
    );
  });

  it('does not expand the body of a quoted delimiter', () => {
    expectTree(
      `cat <<'EOF'\nraw $notexpanded\nEOF`,
      `(program (redirected_statement (command (command_name (word "cat"))) (heredoc_redirect "<<" (heredoc_start "'EOF'") (heredoc_body "raw $notexpanded\\n") (heredoc_end "EOF"))))`,
    );
  });

  it('absorbs trailing words and redirects into the heredoc_redirect', () => {
    expectTree(
      'cat <<EOF arg > out\nbody\nEOF',
      `(program (redirected_statement (command (command_name (word "cat"))) (heredoc_redirect "<<" (heredoc_start "EOF") (word "arg") (file_redirect ">" (word "out")) (heredoc_body (heredoc_content "body\\n")) (heredoc_end "EOF"))))`,
    );
  });

  it('absorbs a pipeline tail into the heredoc_redirect', () => {
    expectTree(
      'cat <<EOF | grep x\nbody\nEOF',
      `(program (redirected_statement (command (command_name (word "cat"))) (heredoc_redirect "<<" (heredoc_start "EOF") (pipeline "|" (command (command_name (word "grep")) (word "x"))) (heredoc_body (heredoc_content "body\\n")) (heredoc_end "EOF"))))`,
    );
  });

  it('absorbs `;` follow-up statements into the heredoc_redirect', () => {
    expectTree(
      'cat <<EOF; echo x\nbody\nEOF',
      `(program (redirected_statement (command (command_name (word "cat"))) (heredoc_redirect "<<" (heredoc_start "EOF") ";" (command (command_name (word "echo")) (word "x")) (heredoc_body (heredoc_content "body\\n")) (heredoc_end "EOF"))))`,
    );
  });

  it('degrades a second heredoc on the same line to ERROR (matches tree-sitter-bash)', () => {
    expectTree(
      'cat <<A <<B\nba\nA\nbb\nB',
      `(program (redirected_statement (command (command_name (word "cat"))) (heredoc_redirect "<<" (heredoc_start "A") (ERROR "<<" (word "B")) (heredoc_body (heredoc_content "ba\\n")) (heredoc_end "A"))) "\\n" (command (command_name (word "bb"))) "\\n" (command (command_name (word "B"))))`,
      true,
    );
  });

  it('recovers from an unterminated heredoc', () => {
    expectTree(
      'cat <<EOF\nno end marker',
      `(program (redirected_statement (command (command_name (word "cat"))) (heredoc_redirect "<<" (heredoc_start "EOF") (heredoc_body (heredoc_content "no end marker")))))`,
      true,
    );
  });
});

describe('statement lists', () => {
  it('mixes semicolons and newlines as terminators', () => {
    expectTree(
      'ls; echo a\necho b',
      `(program (command (command_name (word "ls"))) ";" (command (command_name (word "echo")) (word "a")) "\\n" (command (command_name (word "echo")) (word "b")))`,
    );
  });

  it('parses & background terminators', () => {
    expectTree('a & b &', `(program (command (command_name (word "a"))) "&" (command (command_name (word "b"))) "&")`);
  });

  it('parses |& pipelines', () => {
    expectTree(
      'cmd1 |& cmd2',
      `(program (pipeline (command (command_name (word "cmd1"))) "|&" (command (command_name (word "cmd2")))))`,
    );
  });

  it('parses a subshell', () => {
    expectTree('(ls)', `(program (subshell "(" (command (command_name (word "ls"))) ")"))`);
  });

  it('parses standalone assignments', () => {
    expectTree('FOO=bar ls', `(program (command (variable_assignment (variable_name "FOO") "=" (word "bar")) (command_name (word "ls"))))`);
    expectTree('VAR=value', `(program (variable_assignment (variable_name "VAR") "=" (word "value")))`);
    expectTree(
      'A=1 B=2',
      `(program (variable_assignments (variable_assignment (variable_name "A") "=" (number "1")) (variable_assignment (variable_name "B") "=" (number "2"))))`,
    );
  });

  it('recovers a trailing && with a partial list and hasError', () => {
    expectTree('ls &&', `(program (list (command (command_name (word "ls"))) "&&"))`, true);
  });

  it('recovers a trailing | with a partial pipeline and hasError', () => {
    expectTree('ls |', `(program (pipeline (command (command_name (word "ls"))) "|"))`, true);
  });

  it('continues a list across a newline after &&', () => {
    expectTree(
      'a &&\nb',
      `(program (list (command (command_name (word "a"))) "&&" (command (command_name (word "b")))))`,
    );
  });

  it('splits compound commands into separate command nodes', () => {
    const root = expectTree(
      'git status && rm -rf /',
      `(program (list (command (command_name (word "git")) (word "status")) "&&" (command (command_name (word "rm")) (word "-rf") (word "/"))))`,
    );
    const commands = descendantsOfType(root, 'command');
    expect(commands).toHaveLength(2);
    const argv = commands.map((cmd) =>
      cmd.namedChildren.map((part) => (part.type === 'command_name' ? part.namedChildren[0]!.text : part.text)),
    );
    expect(argv).toEqual([
      ['git', 'status'],
      ['rm', '-rf', '/'],
    ]);
  });
});

describe('offsets', () => {
  it('uses UTF-16 code unit offsets', () => {
    // 🎉 is two UTF-16 code units.
    const { rootNode } = parseOk('x🎉y; ls');
    expect(rootNode.endIndex).toBe(8);
    const commands = descendantsOfType(rootNode, 'command');
    expect(commands).toHaveLength(2);
    expect(commands[0]!.startIndex).toBe(0);
    expect(commands[0]!.endIndex).toBe(4);
    expect(commands[1]!.startIndex).toBe(6);
    expect(commands[1]!.endIndex).toBe(8);
    expect(commands[1]!.text).toBe('ls');
  });

  it('node.text always equals the source slice', () => {
    const source = 'FOO=bar env | grep FOO && echo "ok $X"';
    const { rootNode } = parseOk(source);
    const walk = (node: SyntaxNode): void => {
      expect(node.text).toBe(source.slice(node.startIndex, node.endIndex));
      node.children.forEach(walk);
    };
    walk(rootNode);
  });
});

describe('adversarial input', () => {
  it('recovers unterminated quotes, substitutions and expansions', () => {
    for (const source of ['echo "abc', "echo 'abc", 'echo $(foo', 'echo ${foo', 'echo `foo']) {
      const result = parse(source);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.hasError).toBe(true);
    }
  });

  it('recovers stray operators without throwing', () => {
    for (const source of ['echo )', '&& echo', '| echo', ')']) {
      const result = parse(source);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.hasError).toBe(true);
    }
  });

  it('parses a 500KB double-quoted string under the default budget', () => {
    // Regression: per-character budget.tick() used to burn the 50k node cap
    // on long strings even though only a handful of nodes are created.
    const body = 'a'.repeat(500 * 1024);
    const result = parse(`echo "${body}"`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hasError).toBe(false);
    const content = descendantsOfType(result.rootNode, 'string_content');
    expect(content).toHaveLength(1);
    expect(content[0]!.text).toBe(body);
  });

  it('parses a 500KB heredoc body under the default budget', () => {
    const body = 'b'.repeat(500 * 1024);
    const result = parse(`cat <<EOF\n${body}\nEOF`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hasError).toBe(false);
    const content = descendantsOfType(result.rootNode, 'heredoc_content');
    expect(content).toHaveLength(1);
    expect(content[0]!.text).toBe(`${body}\n`);
  });

  it('handles 1000-level nested ${} expansions within the depth cap', () => {
    const source = 'echo ' + '${a:-'.repeat(1000) + 'x' + '}'.repeat(1000);
    const result = parse(source, { timeoutMs: 10_000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hasError).toBe(true);
  });

  it('handles 1000-level nested command substitutions within the depth cap', () => {
    const source = '$('.repeat(1000) + 'x' + ')'.repeat(1000);
    const result = parse(source, { timeoutMs: 10_000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hasError).toBe(true);
  });

  it('handles 1000-level nested subshells within the depth cap', () => {
    const source = '('.repeat(1000) + 'x' + ')'.repeat(1000);
    const result = parse(source, { timeoutMs: 10_000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hasError).toBe(true);
  });

  it('parses a multi-megabyte single word without throwing', () => {
    const source = 'a'.repeat(2 * 1024 * 1024);
    const result = parse(source, { timeoutMs: 10_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hasError).toBe(false);
    const word = result.rootNode.namedChildren[0]!.namedChildren[0]!.namedChildren[0]!;
    expect(word.type).toBe('word');
    expect(word.text).toBe(source);
  });

  it('does not throw on random binary garbage', () => {
    let source = '';
    for (let i = 0; i < 20_000; i++) {
      source += String.fromCodePoint(Math.floor(Math.random() * 0xd800));
    }
    // The call itself must never throw; either it parses (possibly with
    // errors) or the budget cuts it off.
    const result = parse(source);
    if (result.ok) {
      expect(result.rootNode.type).toBe('program');
    } else {
      expect(result.reason).toBe('aborted');
    }
  });

  it('does not throw on NUL bytes', () => {
    const result = parse('echo \0\0 test \0');
    expect(result.ok).toBe(true);
  });
});
