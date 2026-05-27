# Plan Checklist v1

- **Version:** v1
- **Mode:** plan
- **Created:** auto-seeded

## Purpose

Binary PASS/FAIL checklist for evaluating an implementation plan folder against its source design folder. Each item produces a deterministic or anchored result.

## Artifacts Under Evaluation

- `_index.md` -- plan overview, sprint batching, depends-on graph
- `task-NNN-*.md` -- individual task files (impl + test pairs)
- Source design folder's `bdd-specs.md` -- scenarios the plan must cover

---

## Checklist Items

### PLAN-COV-01 -- Every design BDD scenario maps to at least one task

**Description:** Each `Scenario:` heading in the source design's bdd-specs.md must be covered by at least one task file (matched by scenario title in the task subject line or a BDD Scenario section in the task body).

**Check method:**
```bash
grep -E "^Scenario:" <design-folder>/bdd-specs.md | while read -r line; do
  title="${line#Scenario: }"
  grep -lq "$title" task-*.md || echo "FAIL: scenario '$title' uncovered"
done
```
Any "FAIL" output line means PLAN-COV-01 is FAIL.

**Evidence format:** `N/M scenarios covered; uncovered: {scenario titles}`

**Rework format:** "Add task for scenario: {scenario title}"

**Result:** PASS if every scenario is covered. FAIL otherwise.

`# Type: computational` -- grep for exact scenario titles is deterministic.

---

### DEP-01 -- No circular dependencies in the depends-on graph

**Description:** The depends-on graph defined in `_index.md` must be acyclic.

**Check method:** Walk the depends-on graph from `_index.md`; detect any cycle (task-A → task-B → ... → task-A).

**Evidence format:** `Cycle detected: task-{A} -> task-{B} -> ... -> task-{A}` or `No cycles`

**Rework format:** "Break cycle by removing dependency: task-{A} depends-on task-{B}"

**Result:** PASS if the graph is acyclic. FAIL on any cycle.

`# Type: computational` -- cycle detection on a finite graph is deterministic.

---

### DEP-02 -- All depends-on references resolve to existing task IDs

**Description:** For each `depends-on` entry in `_index.md`, a matching `task-{ID}-*.md` file must exist in the plan folder.

**Check method:**
```bash
grep -oE "task-[0-9]+" _index.md | sort -u | while read -r id; do
  ls "${id}"-*.md >/dev/null 2>&1 || echo "FAIL: $id unresolved"
done
```

**Evidence format:** `Unresolved: {ID list}` or `All resolved`

**Rework format:** "Fix depends-on reference {ID} in {task file} (typo or missing task file)"

**Result:** PASS if every depends-on resolves. FAIL on any unresolved reference.

`# Type: computational` -- file existence check is deterministic.

---

### TEST-01 -- Every impl task has a corresponding test task

**Description:** For each `task-NNN-{slug}-impl.md`, a matching `task-NNN-{slug}-test.md` must exist (BDD-driven TDD requires the RED test before GREEN code).

**Check method:**
```bash
ls task-*-impl.md | while read -r impl; do
  test_file="${impl%-impl.md}-test.md"
  [[ -f "$test_file" ]] || echo "FAIL: $impl missing $test_file"
done
```

**Evidence format:** `Unpaired impl tasks: {list}` or `All paired`

**Rework format:** "Add test task for: task-{NNN}-{slug}-impl.md"

**Result:** PASS if every impl has its test pair. FAIL on any unpaired impl.

`# Type: computational` -- file existence pairing is deterministic.

---

## Evaluation Protocol

1. Run each check method against the plan folder (and its source design folder where indicated).
2. Record PASS or FAIL for each item.
3. For each FAIL, capture evidence in the specified format and produce a rework item.
4. Verdict: all items PASS = **PASS**. Any item FAIL = **REWORK** with itemized rework list.
