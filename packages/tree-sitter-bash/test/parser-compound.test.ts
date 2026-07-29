import { describe, expect, it } from 'vitest';

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

describe('if / while / until', () => {
  it('parses a one-line if statement', () => {
    expectTree(
      'if true; then echo yes; fi',
      `(program (if_statement "if" (command (command_name (word "true"))) ";" "then" (command (command_name (word "echo")) (word "yes")) ";" "fi"))`,
    );
  });

  it('parses elif and else clauses', () => {
    expectTree(
      'if a; then b; elif c; then d; else e; fi',
      `(program (if_statement "if" (command (command_name (word "a"))) ";" "then" (command (command_name (word "b"))) ";" (elif_clause "elif" (command (command_name (word "c"))) ";" "then" (command (command_name (word "d"))) ";") (else_clause "else" (command (command_name (word "e"))) ";") "fi"))`,
    );
  });

  it('parses a multiline if without emitting newline nodes', () => {
    expectTree(
      'if a\nthen\n  b\nfi',
      `(program (if_statement "if" (command (command_name (word "a"))) "then" (command (command_name (word "b"))) "fi"))`,
    );
  });

  it('parses a while loop with a trailing redirect', () => {
    expectTree(
      'while read -r line; do echo "$line"; done < file',
      `(program (redirected_statement (while_statement "while" (command (command_name (word "read")) (word "-r") (word "line")) ";" (do_group "do" (command (command_name (word "echo")) (string "\\"" (simple_expansion "$" (variable_name "line")) "\\"")) ";" "done")) (file_redirect "<" (word "file"))))`,
    );
  });

  it('parses until as a while_statement', () => {
    expectTree(
      'until x; do y; done',
      `(program (while_statement "until" (command (command_name (word "x"))) ";" (do_group "do" (command (command_name (word "y"))) ";" "done")))`,
    );
  });

  it('parses an empty do_group', () => {
    expectTree(
      'while x; do done',
      `(program (while_statement "while" (command (command_name (word "x"))) ";" (do_group "do" "done")))`,
    );
  });

  it('only treats keywords as keywords in statement position', () => {
    expectTree(
      'echo if for while',
      `(program (command (command_name (word "echo")) (word "if") (word "for") (word "while")))`,
    );
    expectTree('fi', `(program (command (command_name (word "fi"))))`);
    expectTree('done', `(program (command (command_name (word "done"))))`);
    expectTree('}', `(program (command (command_name (word "}"))))`);
    expectTree('time ls -la', `(program (command (command_name (word "time")) (word "ls") (word "-la")))`);
    // Reserved words are plain arguments inside conditions and bodies.
    expectTree(
      'if echo then; then x; fi',
      `(program (if_statement "if" (command (command_name (word "echo")) (word "then")) ";" "then" (command (command_name (word "x"))) ";" "fi"))`,
    );
    // A prefix assignment disables the keyword reading.
    expectTree(
      'x=1 if a; then b; fi',
      `(program (command (variable_assignment (variable_name "x") "=" (number "1")) (command_name (word "if")) (word "a")) ";" (command (command_name (word "then")) (word "b")) ";" (command (command_name (word "fi"))))`,
    );
  });
});

describe('for / select', () => {
  it('parses a for-in loop', () => {
    expectTree(
      'for f in a b c; do echo "$f"; done',
      `(program (for_statement "for" (variable_name "f") "in" (word "a") (word "b") (word "c") ";" (do_group "do" (command (command_name (word "echo")) (string "\\"" (simple_expansion "$" (variable_name "f")) "\\"")) ";" "done")))`,
    );
  });

  it('parses a for loop without in', () => {
    expectTree(
      'for f; do x; done',
      `(program (for_statement "for" (variable_name "f") ";" (do_group "do" (command (command_name (word "x"))) ";" "done")))`,
    );
  });

  it('parses select as a for_statement', () => {
    expectTree(
      'select opt in a b; do echo $opt; done',
      `(program (for_statement "select" (variable_name "opt") "in" (word "a") (word "b") ";" (do_group "do" (command (command_name (word "echo")) (simple_expansion "$" (variable_name "opt"))) ";" "done")))`,
    );
  });

  it('parses newline-separated for headers', () => {
    expectTree(
      'for f in a b\ndo x\ndone',
      `(program (for_statement "for" (variable_name "f") "in" (word "a") (word "b") (do_group "do" (command (command_name (word "x"))) "done")))`,
    );
  });

  it('flags a bare `in` with no values as an error', () => {
    expectTree(
      'select x in; do y; done',
      `(program (for_statement "select" (variable_name "x") (ERROR "in") ";" (do_group "do" (command (command_name (word "y"))) ";" "done")))`,
      true,
    );
  });

  it('parses a c-style for loop', () => {
    expectTree(
      'for ((i=0;i<3;i++)); do echo $i; done',
      `(program (c_style_for_statement "for" "((" (variable_assignment (variable_name "i") "=" (number "0")) ";" (binary_expression (word "i") "<" (number "3")) ";" (postfix_expression (word "i") "++") "))" ";" (do_group "do" (command (command_name (word "echo")) (simple_expansion "$" (variable_name "i"))) ";" "done")))`,
    );
  });

  it('parses a spaced c-style for with an update assignment operator', () => {
    expectTree(
      'for (( i = 0; i < 10; i += 2 )); do x; done',
      `(program (c_style_for_statement "for" "((" (variable_assignment (variable_name "i") "=" (number "0")) ";" (binary_expression (word "i") "<" (number "10")) ";" (binary_expression (word "i") "+=" (number "2")) "))" ";" (do_group "do" (command (command_name (word "x"))) ";" "done")))`,
    );
  });

  it('parses an empty c-style for header', () => {
    expectTree(
      'for ((;;)); do x; done',
      `(program (c_style_for_statement "for" "((" ";" ";" "))" ";" (do_group "do" (command (command_name (word "x"))) ";" "done")))`,
    );
  });

  it('parses comma-separated c-style for parts', () => {
    expectTree(
      'for ((i=0,j=1; i<3; i++,j--)); do x; done',
      `(program (c_style_for_statement "for" "((" (variable_assignment (variable_name "i") "=" (number "0")) "," (variable_assignment (variable_name "j") "=" (number "1")) ";" (binary_expression (word "i") "<" (number "3")) ";" (postfix_expression (word "i") "++") "," (postfix_expression (word "j") "--") "))" ";" (do_group "do" (command (command_name (word "x"))) ";" "done")))`,
    );
  });

  it('parses a compound_statement as the c-style for body', () => {
    expectTree(
      'for ((i=0;i<3;i++)) { echo $i; }',
      `(program (c_style_for_statement "for" "((" (variable_assignment (variable_name "i") "=" (number "0")) ";" (binary_expression (word "i") "<" (number "3")) ";" (postfix_expression (word "i") "++") "))" (compound_statement "{" (command (command_name (word "echo")) (simple_expansion "$" (variable_name "i"))) ";" "}")))`,
    );
  });
});

describe('case', () => {
  it('parses a multi-item case with all termination forms', () => {
    expectTree(
      'case $x in\n  a) echo A ;;\n  b|c) echo BC ;&\n  *) echo other ;;\nesac',
      `(program (case_statement "case" (simple_expansion "$" (variable_name "x")) "in" (case_item (word "a") ")" (command (command_name (word "echo")) (word "A")) ";;") (case_item (extglob_pattern "b") "|" (word "c") ")" (command (command_name (word "echo")) (word "BC")) ";&") (case_item (extglob_pattern "*") ")" (command (command_name (word "echo")) (word "other")) ";;") "esac"))`,
    );
  });

  it('parses optional parens and empty item bodies', () => {
    expectTree(
      'case $x in (a) x ;; esac',
      `(program (case_statement "case" (simple_expansion "$" (variable_name "x")) "in" (case_item "(" (word "a") ")" (command (command_name (word "x"))) ";;") "esac"))`,
    );
    expectTree(
      'case x in a) ;; esac',
      `(program (case_statement "case" (word "x") "in" (case_item (word "a") ")" ";;") "esac"))`,
    );
    expectTree(
      'case $x in esac',
      `(program (case_statement "case" (simple_expansion "$" (variable_name "x")) "in" "esac"))`,
    );
  });

  it('parses pattern forms: globs, quotes and expansions', () => {
    expectTree(
      'case $x in [a-z]) x ;; esac',
      `(program (case_statement "case" (simple_expansion "$" (variable_name "x")) "in" (case_item (extglob_pattern "[a-z]") ")" (command (command_name (word "x"))) ";;") "esac"))`,
    );
    expectTree(
      'case $x in "a") x ;; esac',
      `(program (case_statement "case" (simple_expansion "$" (variable_name "x")) "in" (case_item (string "\\"" (string_content "a") "\\"") ")" (command (command_name (word "x"))) ";;") "esac"))`,
    );
    expectTree(
      'case $x in $v|${w}) x ;; esac',
      `(program (case_statement "case" (simple_expansion "$" (variable_name "x")) "in" (case_item (simple_expansion "$" (variable_name "v")) "|" (expansion "\${" (variable_name "w") "}") ")" (command (command_name (word "x"))) ";;") "esac"))`,
    );
  });

  it('ends the last case_item at esac even without ;;', () => {
    expectTree(
      'case $x in a) x esac',
      `(program (case_statement "case" (simple_expansion "$" (variable_name "x")) "in" (case_item (word "a") ")" (command (command_name (word "x")))) "esac"))`,
    );
  });

  it('flags a fallthrough terminator on the last case_item', () => {
    const { hasError } = parseOk('case $x in a) x ;;& esac');
    expect(hasError).toBe(true);
  });
});

describe('functions and compound statements', () => {
  it('parses the name() form', () => {
    expectTree(
      'foo() { echo hi; }',
      `(program (function_definition (word "foo") "(" ")" (compound_statement "{" (command (command_name (word "echo")) (word "hi")) ";" "}")))`,
    );
  });

  it('parses the function keyword forms', () => {
    expectTree(
      'function bar { echo hi; }',
      `(program (function_definition "function" (word "bar") (compound_statement "{" (command (command_name (word "echo")) (word "hi")) ";" "}")))`,
    );
    expectTree(
      'function baz() { echo hi; return 0; }',
      `(program (function_definition "function" (word "baz") "(" ")" (compound_statement "{" (command (command_name (word "echo")) (word "hi")) ";" (command (command_name (word "return")) (number "0")) ";" "}")))`,
    );
    expectTree(
      'f () { x; }',
      `(program (function_definition (word "f") "(" ")" (compound_statement "{" (command (command_name (word "x"))) ";" "}")))`,
    );
  });

  it('parses subshell, test and if bodies', () => {
    expectTree(
      'foo() ( echo sub )',
      `(program (function_definition (word "foo") "(" ")" (subshell "(" (command (command_name (word "echo")) (word "sub")) ")")))`,
    );
    expectTree(
      'foo() [[ -f x ]]',
      `(program (function_definition (word "foo") "(" ")" (test_command "[[" (unary_expression (test_operator "-f") (word "x")) "]]")))`,
    );
    expectTree(
      'foo() if a; then b; fi',
      `(program (function_definition (word "foo") "(" ")" (if_statement "if" (command (command_name (word "a"))) ";" "then" (command (command_name (word "b"))) ";" "fi")))`,
    );
  });

  it('keeps a trailing redirect inside the function_definition', () => {
    expectTree(
      'foo() { x; } > out',
      `(program (function_definition (word "foo") "(" ")" (compound_statement "{" (command (command_name (word "x"))) ";" "}") (file_redirect ">" (word "out"))))`,
    );
  });

  it('parses a standalone compound statement', () => {
    expectTree(
      '{ echo a; echo b; }',
      `(program (compound_statement "{" (command (command_name (word "echo")) (word "a")) ";" (command (command_name (word "echo")) (word "b")) ";" "}"))`,
    );
    expectTree('{ls;}', `(program (compound_statement "{" (command (command_name (word "ls"))) ";" "}"))`);
  });

  it('parses coproc as an ordinary command (like the reference)', () => {
    expectTree(
      'coproc myjob { echo hi; }',
      `(program (command (command_name (word "coproc")) (word "myjob") (word "{") (word "echo") (word "hi")) ";" (command (command_name (word "}"))))`,
    );
  });
});

describe('test commands', () => {
  it('parses unary test operators', () => {
    expectTree(
      '[[ -f file.txt ]]',
      `(program (test_command "[[" (unary_expression (test_operator "-f") (word "file.txt")) "]]"))`,
    );
    expectTree(
      '[[ -z $s ]]',
      `(program (test_command "[[" (unary_expression (test_operator "-z") (simple_expansion "$" (variable_name "s"))) "]]"))`,
    );
  });

  it('parses string comparisons', () => {
    expectTree(
      '[[ $x == "foo" ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "x")) "==" (string "\\"" (string_content "foo") "\\"")) "]]"))`,
    );
    expectTree(
      '[ "$a" = "b" ]',
      `(program (test_command "[" (binary_expression (string "\\"" (simple_expansion "$" (variable_name "a")) "\\"") "=" (string "\\"" (string_content "b") "\\"")) "]"))`,
    );
  });

  it('parses =~ with a regex right side', () => {
    expectTree(
      '[[ $x =~ ^ab+c$ ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "x")) "=~" (regex "^ab+c$")) "]]"))`,
    );
    expectTree(
      '[[ $x =~ a|b ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "x")) "=~" (regex "a|b")) "]]"))`,
    );
    expectTree(
      '[[ $x =~ $re ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "x")) "=~" (simple_expansion "$" (variable_name "re"))) "]]"))`,
    );
  });

  it('parses pattern right sides: regex after =, extglob_pattern after ==/!=', () => {
    expectTree(
      '[[ a = b*c ]]',
      `(program (test_command "[[" (binary_expression (word "a") "=" (regex "b*c")) "]]"))`,
    );
    expectTree(
      '[[ a = bc ]]',
      `(program (test_command "[[" (binary_expression (word "a") "=" (word "bc")) "]]"))`,
    );
    expectTree(
      '[[ $x == b*c ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "x")) "==" (extglob_pattern "b*c")) "]]"))`,
    );
    expectTree(
      '[[ $x == 123 ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "x")) "==" (number "123")) "]]"))`,
    );
  });

  it('parses && / || / ! combinations', () => {
    expectTree(
      '[[ -n $s && -d /tmp ]]',
      `(program (test_command "[[" (binary_expression (unary_expression (test_operator "-n") (simple_expansion "$" (variable_name "s"))) "&&" (unary_expression (test_operator "-d") (word "/tmp"))) "]]"))`,
    );
    expectTree(
      '[[ a < b || ! -e f ]]',
      `(program (test_command "[[" (binary_expression (binary_expression (word "a") "<" (word "b")) "||" (unary_expression "!" (unary_expression (test_operator "-e") (word "f")))) "]]"))`,
    );
  });

  it('parses binary test operators and parentheses', () => {
    expectTree(
      '[[ $a -eq 3 ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "a")) (test_operator "-eq") (number "3")) "]]"))`,
    );
    expectTree(
      '[[ $x -eq 1 && $y -ne 2 ]]',
      `(program (test_command "[[" (binary_expression (binary_expression (simple_expansion "$" (variable_name "x")) (test_operator "-eq") (number "1")) "&&" (binary_expression (simple_expansion "$" (variable_name "y")) (test_operator "-ne") (number "2"))) "]]"))`,
    );
    // Inside parentheses the == right side is a word, not extglob_pattern.
    expectTree(
      '[[ (a == b) && c ]]',
      `(program (test_command "[[" (binary_expression (parenthesized_expression "(" (binary_expression (word "a") "==" (word "b")) ")") "&&" (word "c")) "]]"))`,
    );
  });

  it('parses the single-bracket form and adjacent =', () => {
    expectTree('[ -f file ]', `(program (test_command "[" (unary_expression (test_operator "-f") (word "file")) "]"))`);
    expectTree('[ x ]', `(program (test_command "[" (word "x") "]"))`);
    expectTree('[[ a=b ]]', `(program (test_command "[[" (word "a=b") "]]"))`);
  });

  it('parses negated test commands', () => {
    expectTree(
      '! [[ -f x ]]',
      `(program (negated_command "!" (test_command "[[" (unary_expression (test_operator "-f") (word "x")) "]]")))`,
    );
    expectTree(
      '! [ -f x ]',
      `(program (negated_command "!" (test_command "[" (unary_expression (test_operator "-f") (word "x")) "]")))`,
    );
  });

  it('keeps [ in argument position as plain words', () => {
    expectTree('echo [ x ]', `(program (command (command_name (word "echo")) (word "[") (word "x") (word "]")))`);
  });

  it('recovers an unterminated test command with a zero-width closer', () => {
    expectTree('[ -f file', `(program (test_command "[" (unary_expression (test_operator "-f") (word "file")) "]"))`, true);
  });
});

describe('arithmetic', () => {
  it('parses operator precedence levels', () => {
    expectTree(
      'echo $((1 + 2 * 3))',
      `(program (command (command_name (word "echo")) (arithmetic_expansion "$((" (binary_expression (number "1") "+" (binary_expression (number "2") "*" (number "3"))) "))")))`,
    );
    expectTree(
      'echo $((x << 2 | 1))',
      `(program (command (command_name (word "echo")) (arithmetic_expansion "$((" (binary_expression (binary_expression (variable_name "x") "<<" (number "2")) "|" (number "1")) "))")))`,
    );
    expectTree(
      'echo $((n % 2 == 0))',
      `(program (command (command_name (word "echo")) (arithmetic_expansion "$((" (binary_expression (binary_expression (variable_name "n") "%" (number "2")) "==" (number "0")) "))")))`,
    );
  });

  it('parses ternary, postfix, prefix and unary expressions', () => {
    expectTree(
      'echo $((a > b ? a : b))',
      `(program (command (command_name (word "echo")) (arithmetic_expansion "$((" (ternary_expression (binary_expression (variable_name "a") ">" (variable_name "b")) "?" (variable_name "a") ":" (variable_name "b")) "))")))`,
    );
    expectTree(
      'echo $((i++ + --j))',
      `(program (command (command_name (word "echo")) (arithmetic_expansion "$((" (binary_expression (postfix_expression (variable_name "i") "++") "+" (unary_expression "--" (variable_name "j"))) "))")))`,
    );
    // Prefix operators grab the whole tighter-precedence expression, like
    // the reference: -(x + ~y).
    expectTree(
      'echo $((-x + ~y))',
      `(program (command (command_name (word "echo")) (arithmetic_expansion "$((" (unary_expression "-" (binary_expression (variable_name "x") "+" (unary_expression "~" (variable_name "y")))) "))")))`,
    );
  });

  it('parses parentheses and exponent (left-associative in arithmetic)', () => {
    expectTree(
      'echo $(( (1+2) ** 3 ))',
      `(program (command (command_name (word "echo")) (arithmetic_expansion "$((" (binary_expression (parenthesized_expression "(" (binary_expression (number "1") "+" (number "2")) ")") "**" (number "3")) "))")))`,
    );
    expectTree(
      'echo $((2 ** 3 ** 2))',
      `(program (command (command_name (word "echo")) (arithmetic_expansion "$((" (binary_expression (binary_expression (number "2") "**" (number "3")) "**" (number "2")) "))")))`,
    );
  });

  it('parses assignment operators, subscripts and comma lists', () => {
    expectTree(
      'echo $((x += 5))',
      `(program (command (command_name (word "echo")) (arithmetic_expansion "$((" (binary_expression (variable_name "x") "+=" (number "5")) "))")))`,
    );
    expectTree(
      'echo $((x = y = 1))',
      `(program (command (command_name (word "echo")) (arithmetic_expansion "$((" (binary_expression (binary_expression (variable_name "x") "=" (variable_name "y")) "=" (number "1")) "))")))`,
    );
    expectTree(
      'echo $((arr[0] + 1))',
      `(program (command (command_name (word "echo")) (arithmetic_expansion "$((" (binary_expression (subscript (variable_name "arr") "[" (number "0") "]") "+" (number "1")) "))")))`,
    );
    expectTree(
      'echo $((1, 2, 3))',
      `(program (command (command_name (word "echo")) (arithmetic_expansion "$((" (number "1") "," (number "2") "," (number "3") "))")))`,
    );
  });

  it('parses the ((…)) command and legacy $[…] form', () => {
    expectTree(
      '((x = y + 1))',
      `(program (command (command_name (arithmetic_expansion "((" (binary_expression (variable_name "x") "=" (binary_expression (variable_name "y") "+" (number "1"))) "))"))))`,
    );
    expectTree(
      '(( ls ))',
      `(program (command (command_name (arithmetic_expansion "((" (variable_name "ls") "))"))))`,
    );
    expectTree(
      'echo $[1+2]',
      `(program (command (command_name (word "echo")) (arithmetic_expansion "$[" (binary_expression (number "1") "+" (number "2")) "]")))`,
    );
  });

  it('parses arithmetic across newlines and nested arithmetic', () => {
    expectTree(
      'echo $((\n1 +\n2\n))',
      `(program (command (command_name (word "echo")) (arithmetic_expansion "$((" (binary_expression (number "1") "+" (number "2")) "))")))`,
    );
    expectTree(
      'for ((i = $((1 + 1)); i < 3; i++)); do x; done',
      `(program (c_style_for_statement "for" "((" (variable_assignment (variable_name "i") "=" (arithmetic_expansion "$((" (binary_expression (number "1") "+" (number "1")) "))")) ";" (binary_expression (word "i") "<" (number "3")) ";" (postfix_expression (word "i") "++") "))" ";" (do_group "do" (command (command_name (word "x"))) ";" "done")))`,
    );
  });
});

describe('arrays and subscripts', () => {
  it('parses array assignments', () => {
    expectTree(
      'arr=(a b "c d")',
      `(program (variable_assignment (variable_name "arr") "=" (array "(" (word "a") (word "b") (string "\\"" (string_content "c d") "\\"") ")")))`,
    );
    expectTree(
      'x+=(c d)',
      `(program (variable_assignment (variable_name "x") "+=" (array "(" (word "c") (word "d") ")")))`,
    );
  });

  it('parses subscript assignments', () => {
    expectTree(
      'arr[0]=x',
      `(program (variable_assignment (subscript (variable_name "arr") "[" (number "0") "]") "=" (word "x")))`,
    );
    expectTree(
      'a[i+1]=$y',
      `(program (variable_assignment (subscript (variable_name "a") "[" (word "i+1") "]") "=" (simple_expansion "$" (variable_name "y"))))`,
    );
    expectTree(
      'x[1]+=2',
      `(program (variable_assignment (subscript (variable_name "x") "[" (number "1") "]") "+=" (number "2")))`,
    );
  });

  it('parses subscript expansions including @ and $ indexes', () => {
    expectTree(
      'echo ${arr[@]}',
      `(program (command (command_name (word "echo")) (expansion "\${" (subscript (variable_name "arr") "[" (word "@") "]") "}")))`,
    );
    expectTree(
      'echo ${a[$i]}',
      `(program (command (command_name (word "echo")) (expansion "\${" (subscript (variable_name "a") "[" (simple_expansion "$" (variable_name "i")) "]") "}")))`,
    );
  });
});

describe('declaration and unset commands', () => {
  it('parses export/declare/local/readonly', () => {
    expectTree(
      'export FOO=bar BAZ',
      `(program (declaration_command "export" (variable_assignment (variable_name "FOO") "=" (word "bar")) (variable_name "BAZ")))`,
    );
    expectTree(
      'declare -r x=1',
      `(program (declaration_command "declare" (word "-r") (variable_assignment (variable_name "x") "=" (number "1"))))`,
    );
    expectTree('local y', `(program (declaration_command "local" (variable_name "y")))`);
    expectTree(
      'readonly z=2',
      `(program (declaration_command "readonly" (variable_assignment (variable_name "z") "=" (number "2"))))`,
    );
  });

  it('parses unset', () => {
    expectTree('unset a b', `(program (unset_command "unset" (variable_name "a") (variable_name "b")))`);
  });
});

describe('strings and brace expressions', () => {
  it('parses ANSI-C strings as a single node', () => {
    expectTree(
      `echo $'a\\nb\\t'`,
      `(program (command (command_name (word "echo")) (ansi_c_string "$'a\\\\nb\\\\t'")))`,
    );
  });

  it('parses $"…" as an anonymous $ plus a string (no translated_string)', () => {
    expectTree(
      'echo $"hello $USER"',
      `(program (command (command_name (word "echo")) "$" (string "\\"" (string_content "hello ") (simple_expansion "$" (variable_name "USER")) "\\"")))`,
    );
  });

  it('parses $"…" as translated_string outside argument position', () => {
    expectTree(
      'x=$"v"',
      `(program (variable_assignment (variable_name "x") "=" (translated_string "$" (string "\\"" (string_content "v") "\\""))))`,
    );
    expectTree(
      'cat > $"out"',
      `(program (redirected_statement (command (command_name (word "cat"))) (file_redirect ">" (translated_string "$" (string "\\"" (string_content "out") "\\"")))))`,
    );
    expectTree(
      'for f in $"a"; do x; done',
      `(program (for_statement "for" (variable_name "f") "in" (translated_string "$" (string "\\"" (string_content "a") "\\"")) ";" (do_group "do" (command (command_name (word "x"))) ";" "done")))`,
    );
    // Mid-concatenation the bare $ and the string stay separate pieces.
    expectTree(
      'echo a$"b"',
      `(program (command (command_name (word "echo")) (concatenation (word "a") "$" (string "\\"" (string_content "b") "\\""))))`,
    );
  });

  it('parses {N..M} brace expressions', () => {
    expectTree(
      'echo {1..10}',
      `(program (command (command_name (word "echo")) (brace_expression "{" (number "1") ".." (number "10") "}")))`,
    );
    expectTree(
      'echo a{1..3}b',
      `(program (command (command_name (word "echo")) (concatenation (word "a") (brace_expression "{" (number "1") ".." (number "3") "}") (word "b"))))`,
    );
    expectTree(
      'x={1..5}',
      `(program (variable_assignment (variable_name "x") "=" (brace_expression "{" (number "1") ".." (number "5") "}")))`,
    );
    expectTree(
      '{1..3}',
      `(program (command (command_name (brace_expression "{" (number "1") ".." (number "3") "}"))))`,
    );
  });

  it('parses other brace forms as plain concatenations (like the reference)', () => {
    expectTree(
      'echo {1..10..2}',
      `(program (command (command_name (word "echo")) (concatenation (word "{") (word "1..10..2") (word "}"))))`,
    );
    expectTree(
      'echo {a..z}',
      `(program (command (command_name (word "echo")) (concatenation (word "{") (word "a..z") (word "}"))))`,
    );
    expectTree(
      'echo {-5..5}',
      `(program (command (command_name (word "echo")) (concatenation (word "{") (word "-5..5") (word "}"))))`,
    );
    expectTree(
      'echo a{b,c}d',
      `(program (command (command_name (word "echo")) (concatenation (word "a") (word "{") (word "b,c") (word "}") (word "d"))))`,
    );
  });
});

describe('expansion operators', () => {
  it('parses removal patterns as regex nodes', () => {
    expectTree(
      'echo ${x##*/} ${x%%.*}',
      `(program (command (command_name (word "echo")) (expansion "\${" (variable_name "x") "##" (regex "*/") "}") (expansion "\${" (variable_name "x") "%%" (regex ".*") "}")))`,
    );
    expectTree(
      'echo ${x##a b}',
      `(program (command (command_name (word "echo")) (expansion "\${" (variable_name "x") "##" (regex "a b") "}")))`,
    );
    expectTree(
      'echo ${x#"pat"}',
      `(program (command (command_name (word "echo")) (expansion "\${" (variable_name "x") "#" (string "\\"" (string_content "pat") "\\"") "}")))`,
    );
  });

  it('parses replacements with regex pattern and literal replacement', () => {
    expectTree(
      'echo ${x/y/z} ${x//a/b}',
      `(program (command (command_name (word "echo")) (expansion "\${" (variable_name "x") "/" (regex "y") "/" (word "z") "}") (expansion "\${" (variable_name "x") "//" (regex "a") "/" (word "b") "}")))`,
    );
    expectTree(
      'echo ${x/a b/c}',
      `(program (command (command_name (word "echo")) (expansion "\${" (variable_name "x") "/" (regex "a b") "/" (word "c") "}")))`,
    );
    expectTree(
      'echo ${x/a/$v}',
      `(program (command (command_name (word "echo")) (expansion "\${" (variable_name "x") "/" (regex "a") "/" (simple_expansion "$" (variable_name "v")) "}")))`,
    );
    expectTree(
      'echo ${x/pat/rep/extra}',
      `(program (command (command_name (word "echo")) (expansion "\${" (variable_name "x") "/" (regex "pat") "/" (word "rep/extra") "}")))`,
    );
  });

  it('parses case modification and transformation operators', () => {
    expectTree(
      'echo ${x^} ${x,,}',
      `(program (command (command_name (word "echo")) (expansion "\${" (variable_name "x") "^" "}") (expansion "\${" (variable_name "x") ",," "}")))`,
    );
    expectTree(
      'echo ${x@Q}',
      `(program (command (command_name (word "echo")) (expansion "\${" (variable_name "x") "@" "Q" "}")))`,
    );
  });

  it('parses max-length expansions with arithmetic values', () => {
    expectTree(
      'echo ${v:1:2}',
      `(program (command (command_name (word "echo")) (expansion "\${" (variable_name "v") ":" (number "1") ":" (number "2") "}")))`,
    );
    expectTree(
      'echo ${arr[@]:1:2}',
      `(program (command (command_name (word "echo")) (expansion "\${" (subscript (variable_name "arr") "[" (word "@") "]") ":" (number "1") ":" (number "2") "}")))`,
    );
  });

  it('parses default values as words, splitting bare values with spaces', () => {
    expectTree(
      'echo ${v:-1} ${v:=2x}',
      `(program (command (command_name (word "echo")) (expansion "\${" (variable_name "v") ":-" (word "1") "}") (expansion "\${" (variable_name "v") ":=" (word "2x") "}")))`,
    );
    expectTree(
      'echo ${x:-d e f}',
      `(program (command (command_name (word "echo")) (expansion "\${" (variable_name "x") ":-" (concatenation (word "d") (word " e f")) "}")))`,
    );
    expectTree(
      'echo ${v:-"d e"}',
      `(program (command (command_name (word "echo")) (expansion "\${" (variable_name "v") ":-" (string "\\"" (string_content "d e") "\\"") "}")))`,
    );
  });

  it('parses indirect expansions with trailing * and @', () => {
    expectTree(
      'echo ${!prefix*} ${!name@}',
      `(program (command (command_name (word "echo")) (expansion "\${" "!" (variable_name "prefix") "*" "}") (expansion "\${" "!" (variable_name "name") "@" "}")))`,
    );
  });
});

describe('combinations', () => {
  it('nests if inside for inside case', () => {
    expectTree(
      'case $1 in start) for s in a b; do if [[ -n $s ]]; then echo "$s"; fi; done ;; *) echo usage ;; esac',
      `(program (case_statement "case" (simple_expansion "$" (variable_name "1")) "in" (case_item (word "start") ")" (for_statement "for" (variable_name "s") "in" (word "a") (word "b") ";" (do_group "do" (if_statement "if" (test_command "[[" (unary_expression (test_operator "-n") (simple_expansion "$" (variable_name "s"))) "]]") ";" "then" (command (command_name (word "echo")) (string "\\"" (simple_expansion "$" (variable_name "s")) "\\"")) ";" "fi") ";" "done")) ";;") (case_item (extglob_pattern "*") ")" (command (command_name (word "echo")) (word "usage")) ";;") "esac"))`,
    );
  });

  it('parses a heredoc inside a function body', () => {
    expectTree(
      'foo() { cat <<EOF\nbody $x\nEOF\n}',
      `(program (function_definition (word "foo") "(" ")" (compound_statement "{" (redirected_statement (command (command_name (word "cat"))) (heredoc_redirect "<<" (heredoc_start "EOF") (heredoc_body (heredoc_content "body ") (simple_expansion "$" (variable_name "x")) (heredoc_content "\\n")) (heredoc_end "EOF"))) "}")))`,
    );
  });

  it('parses compound commands in pipelines and lists', () => {
    expectTree(
      'if a; then b; fi | grep x',
      `(program (pipeline (if_statement "if" (command (command_name (word "a"))) ";" "then" (command (command_name (word "b"))) ";" "fi") "|" (command (command_name (word "grep")) (word "x"))))`,
    );
    expectTree(
      'if a; then b; fi && c',
      `(program (list (if_statement "if" (command (command_name (word "a"))) ";" "then" (command (command_name (word "b"))) ";" "fi") "&&" (command (command_name (word "c")))))`,
    );
    expectTree(
      'echo hi | if a; then b; fi',
      `(program (pipeline (command (command_name (word "echo")) (word "hi")) "|" (if_statement "if" (command (command_name (word "a"))) ";" "then" (command (command_name (word "b"))) ";" "fi")))`,
    );
  });

  it('parses redirects on compound statements', () => {
    expectTree(
      'if a; then b; fi > out',
      `(program (redirected_statement (if_statement "if" (command (command_name (word "a"))) ";" "then" (command (command_name (word "b"))) ";" "fi") (file_redirect ">" (word "out"))))`,
    );
  });

  it('parses test commands as loop conditions', () => {
    expectTree(
      'while [[ -n $s ]]; do s=; done',
      `(program (while_statement "while" (test_command "[[" (unary_expression (test_operator "-n") (simple_expansion "$" (variable_name "s"))) "]]") ";" (do_group "do" (variable_assignment (variable_name "s") "=") ";" "done")))`,
    );
    expectTree(
      'if [ -f f ]; then x; fi',
      `(program (if_statement "if" (test_command "[" (unary_expression (test_operator "-f") (word "f")) "]") ";" "then" (command (command_name (word "x"))) ";" "fi"))`,
    );
  });

  it('parses negation, lists and nested ifs in conditions', () => {
    expectTree(
      'if ! grep -q x f; then echo missing; fi',
      `(program (if_statement "if" (negated_command "!" (command (command_name (word "grep")) (word "-q") (word "x") (word "f"))) ";" "then" (command (command_name (word "echo")) (word "missing")) ";" "fi"))`,
    );
    expectTree(
      'if a && b; then c; fi',
      `(program (if_statement "if" (list (command (command_name (word "a"))) "&&" (command (command_name (word "b")))) ";" "then" (command (command_name (word "c"))) ";" "fi"))`,
    );
    expectTree(
      'if if a; then b; fi; then c; fi',
      `(program (if_statement "if" (if_statement "if" (command (command_name (word "a"))) ";" "then" (command (command_name (word "b"))) ";" "fi") ";" "then" (command (command_name (word "c"))) ";" "fi"))`,
    );
  });

  it('parses arrays and subscript expansions inside functions', () => {
    expectTree(
      'f() { arr=(1 2); echo ${arr[0]}; }',
      `(program (function_definition (word "f") "(" ")" (compound_statement "{" (variable_assignment (variable_name "arr") "=" (array "(" (number "1") (number "2") ")")) ";" (command (command_name (word "echo")) (expansion "\${" (subscript (variable_name "arr") "[" (number "0") "]") "}")) ";" "}")))`,
    );
  });

  it('parses a command subshell argument and command substitutions in for values', () => {
    expectTree(
      'foo (ls)',
      `(program (command (command_name (word "foo")) (subshell "(" (command (command_name (word "ls"))) ")")))`,
    );
    expectTree(
      'for i in $(seq 3); do echo $i; done',
      `(program (for_statement "for" (variable_name "i") "in" (command_substitution "$(" (command (command_name (word "seq")) (number "3")) ")") ";" (do_group "do" (command (command_name (word "echo")) (simple_expansion "$" (variable_name "i"))) ";" "done")))`,
    );
  });
});

describe('recovery and adversarial input', () => {
  it('recovers unterminated compound commands without throwing', () => {
    for (const source of [
      'if a; then b',
      'if a',
      'while x; do y',
      'for f in a b; do x',
      'case $x in a) x',
      'case $x',
      'foo() { x;',
      '{ x;',
      'function f',
      'for ((i=0;i<3',
      'echo $((1 + ',
      '[[ -f x',
      'arr=(1 2',
    ]) {
      const result = parse(source);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.hasError).toBe(true);
    }
  });

  it('recovers stray case terminators at top level', () => {
    for (const source of ['a ;& b', 'a ;;& b', ';;&']) {
      const result = parse(source);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.hasError).toBe(true);
    }
  });

  it('flags an empty subshell', () => {
    const result = parse('()');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hasError).toBe(true);
  });

  it('handles deeply nested compound commands within the depth cap', () => {
    const source = 'if a; then '.repeat(600) + 'b' + ' fi'.repeat(600);
    const result = parse(source, { timeoutMs: 10_000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hasError).toBe(true);
  });

  it('handles deeply nested arithmetic parentheses within the depth cap', () => {
    const source = 'echo $(( ' + '('.repeat(600) + '1' + ')'.repeat(600) + ' ))';
    const result = parse(source, { timeoutMs: 10_000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hasError).toBe(true);
  });

  it('handles deeply nested case statements within the depth cap', () => {
    const source = 'case x in a) '.repeat(600) + 'y' + ' ;; esac'.repeat(600);
    const result = parse(source, { timeoutMs: 10_000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hasError).toBe(true);
  });

  it('parses a pathological test command under budget', () => {
    const result = parse('[[ ' + 'a && '.repeat(2000) + 'a ]]');
    // Either parses (with bounded work) or the budget cuts it off; never throws.
    if (result.ok) {
      expect(result.rootNode.type).toBe('program');
    } else {
      expect(result.reason).toBe('aborted');
    }
  });
});

describe('M2 review regressions', () => {
  it('keeps a full case_statement inside $() despite pattern parens', () => {
    expectTree(
      'x=$(case y in a) 1;; esac)',
      `(program (variable_assignment (variable_name "x") "=" (command_substitution "$(" (case_statement "case" (word "y") "in" (case_item (word "a") ")" (command (command_name (number "1"))) ";;") "esac") ")")))`,
    );
    // Optional-paren item form stays balanced too.
    expectTree(
      'x=$(case y in (b) 2;; esac)',
      `(program (variable_assignment (variable_name "x") "=" (command_substitution "$(" (case_statement "case" (word "y") "in" (case_item "(" (word "b") ")" (command (command_name (number "2"))) ";;") "esac") ")")))`,
    );
    expectTree(
      'diff <(case y in a) 1;; esac) other',
      `(program (command (command_name (word "diff")) (process_substitution "<(" (case_statement "case" (word "y") "in" (case_item (word "a") ")" (command (command_name (number "1"))) ";;") "esac") ")") (word "other")))`,
    );
  });

  it('does not mistake an argument named case for a case_statement in $()', () => {
    expectTree(
      '$(echo case; ls)',
      `(program (command (command_name (command_substitution "$(" (command (command_name (word "echo")) (word "case")) ";" (command (command_name (word "ls"))) ")"))))`,
    );
  });

  it('converts test right-hand sides by operator, glob and paren depth', () => {
    expectTree(
      '[[ ( $a == x* ) ]]',
      `(program (test_command "[[" (parenthesized_expression "(" (binary_expression (simple_expansion "$" (variable_name "a")) "==" (extglob_pattern "x*")) ")") "]]"))`,
    );
    expectTree(
      '[[ ( $a = x* ) ]]',
      `(program (test_command "[[" (parenthesized_expression "(" (binary_expression (simple_expansion "$" (variable_name "a")) "=" (word "x*")) ")") "]]"))`,
    );
    expectTree(
      '[[ $x == b=c ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "x")) "==" (word "b=c")) "]]"))`,
    );
    expectTree(
      '[[ a = b=c ]]',
      `(program (test_command "[[" (binary_expression (word "a") "=" (regex "b=c")) "]]"))`,
    );
    expectTree(
      '[[ a = =b ]]',
      `(program (test_command "[[" (binary_expression (word "a") "=" (regex "=b")) "]]"))`,
    );
  });

  it('parses statement-position ((word++…)) as a test_command', () => {
    expectTree('((a++))', `(program (test_command "((" (word "a++") "))"))`);
    expectTree('((a--))', `(program (test_command "((" (word "a--") "))"))`);
    expectTree(
      '((a++ + b))',
      `(program (test_command "((" (binary_expression (word "a++") "+" (word "b")) "))"))`,
    );
    // Other ((…)) forms and non-statement positions stay arithmetic.
    expectTree(
      '((b + a++))',
      `(program (command (command_name (arithmetic_expansion "((" (binary_expression (variable_name "b") "+" (postfix_expression (variable_name "a") "++")) "))"))))`,
    );
    expectTree(
      'echo ((a++))',
      `(program (command (command_name (word "echo")) (arithmetic_expansion "((" (postfix_expression (variable_name "a") "++") "))")))`,
    );
    expectTree(
      '! ((a++))',
      `(program (negated_command "!" (test_command "((" (word "a++") "))")))`,
    );
  });

  it('keeps unconsumed expression input in ERROR nodes', () => {
    const arithmetic = parseOk('echo $((x[1][2]))');
    expect(arithmetic.hasError).toBe(true);
    expect(sexp(arithmetic.rootNode)).toBe(
      `(program (command (command_name (word "echo")) (arithmetic_expansion "$((" (subscript (variable_name "x") "[" (number "1") "]") (ERROR "[2]") "))")))`,
    );
    const test = parseOk('[[ $a =~ a b ]]');
    expect(test.hasError).toBe(true);
    const errors = descendantsOfType(test.rootNode, 'ERROR');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.text).toContain('b');
  });

  it('parses negative offsets in max-length expansions as numbers', () => {
    expectTree(
      'echo ${x: -5}',
      `(program (command (command_name (word "echo")) (expansion "\${" (variable_name "x") ":" (number "-5") "}")))`,
    );
    expectTree(
      'echo ${x: -5:2}',
      `(program (command (command_name (word "echo")) (expansion "\${" (variable_name "x") ":" (number "-5") ":" (number "2") "}")))`,
    );
  });

  it('parses $0 and ${0} as special_variable_name', () => {
    expectTree(
      'echo $0 ${0} $1 ${10}',
      `(program (command (command_name (word "echo")) (simple_expansion "$" (special_variable_name "0")) (expansion "\${" (special_variable_name "0") "}") (simple_expansion "$" (variable_name "1")) (expansion "\${" (variable_name "10") "}")))`,
    );
  });

  it('degrades locally on deep pattern→string→expansion nesting', () => {
    let inner = '${a#""}';
    for (let k = 0; k < 650; k++) inner = `\${a#"${inner}"}`;
    const result = parse(`echo ${inner}`, { timeoutMs: 10_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hasError).toBe(true);
    // Local degradation: the tree keeps the outer expansions instead of
    // collapsing into a single ERROR child under program.
    expect(result.rootNode.children[0]!.type).not.toBe('ERROR');
    expect(descendantsOfType(result.rootNode, 'expansion').length).toBeGreaterThan(100);
  });

  it('treats = and ! as word characters at operand position in tests', () => {
    expectTree('[[ a!=b ]]', `(program (test_command "[[" (word "a!=b") "]]"))`);
    expectTree('[[ a=b ]]', `(program (test_command "[[" (word "a=b") "]]"))`);
    expectTree(
      '[[ !x = y ]]',
      `(program (test_command "[[" (binary_expression (word "!x") "=" (word "y")) "]]"))`,
    );
    expectTree(
      '[[ $a==b* ]]',
      `(program (test_command "[[" (concatenation (simple_expansion "$" (variable_name "a")) (word "==b*")) "]]"))`,
    );
    // But they are operators at operator position, even when attached.
    expectTree(
      '[[ a ==b ]]',
      `(program (test_command "[[" (binary_expression (word "a") "==" (extglob_pattern "b")) "]]"))`,
    );
    expectTree(
      '[[ a =b ]]',
      `(program (test_command "[[" (binary_expression (word "a") "=" (word "b")) "]]"))`,
    );
    expectTree(
      '[[ $a =~^x ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "a")) "=~" (regex "^x")) "]]"))`,
    );
  });

  it('parses [[ ]] as a concatenation plus a zero-width closer (reference quirk)', () => {
    expectTree(
      '[[ ]]',
      `(program (test_command "[[" (concatenation (word "]") (word "]")) "]]"))`,
      true,
    );
  });

  it('parses bare numbers inside square brackets as number pieces', () => {
    expectTree(
      'echo [1] a[2]b',
      `(program (command (command_name (word "echo")) (concatenation (word "[") (number "1") (word "]")) (concatenation (word "a") (word "[") (number "2") (word "]") (word "b"))))`,
    );
    expectTree(
      'echo a[-5]b',
      `(program (command (command_name (word "echo")) (concatenation (word "a") (word "[") (number "-5") (word "]") (word "b"))))`,
    );
  });
});

describe('M2 review round 2 regressions', () => {
  it('applies the scanner.c extglob_pattern rule to ==/!= right sides', () => {
    // Single letter followed by whitespace → glob; followed by `)` → word.
    expectTree(
      '[[ $a == b ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "a")) "==" (extglob_pattern "b")) "]]"))`,
    );
    expectTree(
      '[[ (a == b) && c ]]',
      `(program (test_command "[[" (binary_expression (parenthesized_expression "(" (binary_expression (word "a") "==" (word "b")) ")") "&&" (word "c")) "]]"))`,
    );
    expectTree(
      '[[ ( $a == x ) ]]',
      `(program (test_command "[[" (parenthesized_expression "(" (binary_expression (simple_expansion "$" (variable_name "a")) "==" (extglob_pattern "x")) ")") "]]"))`,
    );
    // Multi-character all-letter words stay words, dots don't count.
    expectTree(
      '[[ $a == foo ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "a")) "==" (word "foo")) "]]"))`,
    );
    expectTree(
      '[[ $a == x.y ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "a")) "==" (word "x.y")) "]]"))`,
    );
    // Any non-letter non-dot character makes it a glob.
    for (const word of ['x1', 'foo-', 'x_', 'b*c=d', 'bc=d', 'b?=e', '.x', 'a-b']) {
      const result = parseOk(`[[ $a == ${word} ]]`);
      const globs = descendantsOfType(result.rootNode, 'extglob_pattern');
      expect(globs.map((g) => g.text)).toEqual([word]);
    }
    // `=` vetoes only as the second character; a leading `=` vetoes too.
    expectTree(
      '[[ $x == b=c ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "x")) "==" (word "b=c")) "]]"))`,
    );
    expectTree(
      '[[ a == =b ]]',
      `(program (test_command "[[" (binary_expression (word "a") "==" (word "=b")) "]]"))`,
    );
    // Round-1 fixed behavior must not regress.
    expectTree(
      '[[ $x == b*c ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "x")) "==" (extglob_pattern "b*c")) "]]"))`,
    );
    expectTree(
      '[[ $x == 123 ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "x")) "==" (number "123")) "]]"))`,
    );
    expectTree(
      '[[ a ==b ]]',
      `(program (test_command "[[" (binary_expression (word "a") "==" (extglob_pattern "b")) "]]"))`,
    );
  });

  it('keeps the = right-side regex rule independent of the glob rule', () => {
    expectTree(
      '[[ a = b*c ]]',
      `(program (test_command "[[" (binary_expression (word "a") "=" (regex "b*c")) "]]"))`,
    );
    expectTree(
      '[[ a = bc ]]',
      `(program (test_command "[[" (binary_expression (word "a") "=" (word "bc")) "]]"))`,
    );
    expectTree(
      '[[ a = b=c ]]',
      `(program (test_command "[[" (binary_expression (word "a") "=" (regex "b=c")) "]]"))`,
    );
    expectTree(
      '[[ ( $a = x* ) ]]',
      `(program (test_command "[[" (parenthesized_expression "(" (binary_expression (simple_expansion "$" (variable_name "a")) "=" (word "x*")) ")") "]]"))`,
    );
  });

  it('survives 2500 levels of lexer-side pattern nesting', () => {
    let inner = '${a#""}';
    for (let k = 0; k < 2500; k++) inner = `\${a#"${inner}"}`;
    const result = parse(`echo ${inner}`, { timeoutMs: 30_000 });
    // No RangeError, no abort: the scan depth cap degrades locally.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hasError).toBe(true);
    expect(result.rootNode.children[0]!.type).not.toBe('ERROR');
  });

  it('parses ((…)) inside a test as an arithmetic_expansion', () => {
    expectTree(
      '[[ ((a)) == x ]]',
      `(program (test_command "[[" (binary_expression (arithmetic_expansion "((" (variable_name "a") "))") "==" (extglob_pattern "x")) "]]"))`,
    );
    // Without the closing )), parens still nest as parenthesized_expressions.
    expectTree(
      '[[ ((a) == x) && y ]]',
      `(program (test_command "[[" (binary_expression (parenthesized_expression "(" (binary_expression (parenthesized_expression "(" (word "a") ")") "==" (word "x")) ")") "&&" (word "y")) "]]"))`,
    );
  });

  it('parses ((ab-cd++)) as a test_command', () => {
    expectTree('((ab-cd++))', `(program (test_command "((" (word "ab-cd++") "))"))`);
  });

  it('flags a missing separator before a compound keyword', () => {
    for (const source of [
      'if a; then case x in b) 1;; esac elif c; then d; fi',
      'if a; then b fi',
      '{ ls }',
      'while x do y done',
      'for f in a b; do x done',
    ]) {
      const result = parse(source);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.hasError).toBe(true);
    }
    // Valid inputs stay clean: case items need no terminator before esac,
    // subshells none before ), compounds with proper terminators.
    for (const source of ['if a; then b; fi', '{ ls; }', '(ls)', 'case $x in a) x esac', 'while x; do y; done']) {
      const result = parse(source);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.hasError).toBe(false);
    }
  });
});

describe('M2 review round 3 regressions', () => {
  it('converts […]-containing glob right sides as a whole', () => {
    expectTree(
      '[[ $ver == [0-9]* ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "ver")) "==" (extglob_pattern "[0-9]*")) "]]"))`,
    );
    expectTree(
      '[[ $a == [abc] ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "a")) "==" (extglob_pattern "[abc]")) "]]"))`,
    );
    expectTree(
      '[[ ( $a == [xyz] ) ]]',
      `(program (test_command "[[" (parenthesized_expression "(" (binary_expression (simple_expansion "$" (variable_name "a")) "==" (extglob_pattern "[xyz]")) ")") "]]"))`,
    );
    expectTree(
      '[[ $a == [!a]* ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "a")) "==" (extglob_pattern "[!a]*")) "]]"))`,
    );
    expectTree(
      '[[ $a = [abc] ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "a")) "=" (regex "[abc]")) "]]"))`,
    );
    // Bracket fragments outside test commands are untouched.
    expectTree(
      'echo a[2]b',
      `(program (command (command_name (word "echo")) (concatenation (word "a") (word "[") (number "2") (word "]") (word "b"))))`,
    );
  });

  it('keeps -word as a word when no operand follows it', () => {
    expectTree(
      '[[ $a == -foo ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "a")) "==" (word "-foo")) "]]"))`,
    );
    expectTree(
      '[[ -foo == x ]]',
      `(program (test_command "[[" (binary_expression (word "-foo") "==" (extglob_pattern "x")) "]]"))`,
    );
    expectTree('[[ -f ]]', `(program (test_command "[[" (word "-f") "]]"))`);
    // A real operand still makes it a test_operator.
    expectTree(
      '[[ -f file.txt ]]',
      `(program (test_command "[[" (unary_expression (test_operator "-f") (word "file.txt")) "]]"))`,
    );
  });

  it('parses extglob group patterns after ==/!=', () => {
    expectTree(
      '[[ $a == +(!a) ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "a")) "==" (extglob_pattern "+(!a)")) "]]"))`,
    );
    expectTree(
      '[[ $a == ?(a|b) ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "a")) "==" (extglob_pattern "?(a|b)")) "]]"))`,
    );
    expectTree(
      '[[ $a == !(x) ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "a")) "==" (extglob_pattern "!(x)")) "]]"))`,
    );
  });

  it('parses a negative number operand in tests as unary minus', () => {
    expectTree(
      '[[ $a == -1 ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "a")) "==" (unary_expression "-" (number "1"))) "]]"))`,
    );
    expectTree(
      '[[ $a -eq -1 ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "a")) (test_operator "-eq") (unary_expression "-" (number "1"))) "]]"))`,
    );
  });

  it('handles escaped characters in glob right sides', () => {
    expectTree(
      '[[ $a == foo\\ bar ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "a")) "==" (word "foo\\\\ bar")) "]]"))`,
    );
    expectTree(
      '[[ $a == b\\*c ]]',
      `(program (test_command "[[" (binary_expression (simple_expansion "$" (variable_name "a")) "==" (extglob_pattern "b\\\\*c")) "]]"))`,
    );
  });

  it('extends elif/else clause ranges over the trailing newline', () => {
    const { rootNode, hasError } = parseOk('if a; then b; elif c; then d\nelse e\nfi');
    expect(hasError).toBe(false);
    const elifClause = descendantsOfType(rootNode, 'elif_clause')[0]!;
    const elseClause = descendantsOfType(rootNode, 'else_clause')[0]!;
    expect(elifClause.text).toBe('elif c; then d\n');
    expect(elseClause.text).toBe('else e\n');
  });

  it('degrades 400-level command substitution nesting locally', () => {
    const source = 'echo ' + '$('.repeat(400) + 'x' + ')'.repeat(400);
    const result = parse(source, { timeoutMs: 10_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hasError).toBe(true);
    // Local degradation (MAX_SUBSTITUTION_DEPTH), not a last-resort
    // single-ERROR root.
    expect(result.rootNode.children[0]!.type).not.toBe('ERROR');
    expect(descendantsOfType(result.rootNode, 'command_substitution').length).toBeGreaterThan(100);
  });
});
