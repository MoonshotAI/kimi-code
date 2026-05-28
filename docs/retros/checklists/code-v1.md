# Code Checklist v1

- **Version:** v1
- **Mode:** code
- **Created:** auto-seeded

## Purpose

Binary PASS/FAIL checklist for evaluating produced code artifacts at the end of a sprint batch. Each item produces a deterministic result: re-running the check against the same files yields the same outcome.

## Artifacts Under Evaluation

- Files created or modified by the batch (per sprint contract `Produced` list)
- Verification commands listed in each task file

---

## Checklist Items

### CODE-VER-01 -- All verification commands exit with code 0

**Description:** Every verification command listed in a task file must be executed independently in a fresh shell and exit with code 0. Do not chain commands with `&&` (a failure in one would mask later results).

**Check method:**
1. Extract every verification command from each task file produced in the batch.
2. Run each command independently in a clean shell.
3. Capture the exit code of each command.
4. PASS only if every command returns exit code 0.

**Evidence format:** For each verification command, record `command`, `exit_code`, and `output_tail` (last 10 lines of combined stdout/stderr).

**Rework format:** "Fix failing verification: {cmd} exits {code}; error: {output}"

**Result:** PASS if all exit codes are 0. FAIL if any exit code is non-zero.

`# Type: computational` -- exit code is deterministic ground truth.

---

### CODE-QUAL-01 -- No TODO/FIXME/HACK/XXX/STUB markers in produced files

**Description:** Files created or modified by the batch must be free of placeholder markers that indicate incomplete or deferred work.

**Check method:**
```bash
grep -rn -E '(TODO|FIXME|HACK|XXX|STUB|stub\b)' <produced-files>
```
Patterns are case-sensitive except `stub` which matches case-insensitively via the `\b` word boundary.

**Evidence format:** `{file}:{line} -- {match}`

**Rework format:** "Remove placeholder at {file}:{line}; implement real logic."

**Result:** PASS if grep returns no matches. FAIL on any match.

`# Type: computational` -- grep for exact strings is deterministic.

---

### CODE-QUAL-02 -- No stub implementations (NotImplementedError, pass-only, ellipsis-only bodies)

**Description:** Functions and methods in produced files must contain real implementations, not placeholder bodies.

**Check method:**
```bash
grep -rn 'NotImplementedError' <produced-files>
grep -rn -E '^[[:space:]]+pass[[:space:]]*$' <produced-files>
grep -rn -E '^[[:space:]]+\.\.\.[[:space:]]*$' <produced-files>
```
Each grep is run independently; any match from any grep is a failure.

**Evidence format:** `{file}:{line} -- {stub pattern}`

**Rework format:** "Implement real logic in {file} function {name}."

**Result:** PASS if all three greps return no matches. FAIL on any match.

`# Type: computational` -- grep for exact patterns is deterministic.

---

## Evaluation Protocol

1. Run all checks against the set of files created or modified by the batch, not the entire repository.
2. Each check is independent and produces a binary PASS/FAIL result.
3. Evidence must be captured verbatim from command output, not summarized or paraphrased.
4. Verdict: all items PASS = **PASS**. Any item FAIL = **REWORK** with itemized rework list.
