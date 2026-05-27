# Design Checklist v1

- **Version:** v1
- **Mode:** design
- **Created:** auto-seeded

## Purpose

Binary PASS/FAIL checklist for evaluating design artifacts. Each item produces a deterministic or anchored result: two independent evaluators given the same artifacts should produce the same PASS/FAIL outcome. Every FAIL must include file-referenced evidence and a specific rework action.

## Artifacts Under Evaluation

- `_index.md` -- plan overview, requirements, risks
- `bdd-specs.md` -- Gherkin scenarios
- `architecture.md` -- system architecture and layer descriptions
- `best-practices.md` -- coding and design standards (when present)

---

## Checklist Items

### JUST-01 -- Design must not self-declare NOT-JUSTIFIED

**Description:** A design folder whose `_index.md` carries an explicit "not yet justified" / "do not implement" status declared by the maintainer or a prior brainstorming sub-agent must not pass evaluation. The design's own §0-style status is dispositive — content-quality items below cannot override it. This is the meta-check that prevents the v2.8.x add-bias pattern from being replicated at the design layer: a design folder can pass content-quality items while being self-declared as N=0-justified or activation-gated.

**Check method:**
```bash
grep -nE "STATUS:.*NOT.JUSTIFIED|DESIGN-NOT-YET-JUSTIFIED|DESIGN-CONSIDERED-DEFERRED|DO NOT IMPLEMENT" _index.md
```
Any match is a FAIL. Zero matches is PASS.

**Evidence format:** `_index.md:{line} -- "{matched line text}"`

**Rework format:** Either (a) remove the NOT-JUSTIFIED status from `_index.md` after addressing the underlying activation gate, or (b) move the design folder to `docs/retros/<date>-<topic>-considered-deferred.md` (single-file reject form).

**Verdict precedence:** A JUST-01 FAIL produces REWORK regardless of how content-quality items resolve. Other items still run for completeness in the report, but no combination of content-quality PASS results can override a self-declared NOT-JUSTIFIED status.

`# Type: computational` -- grep against fixed-phrase list produces deterministic match.

---

### REQ-TRACE-01 -- Every requirement ID in _index.md appears in at least one scenario in bdd-specs.md

**Description:** Each requirement identifier (pattern: `REQ-NNN`) listed in the Requirements section of _index.md must be referenced by at least one scenario in bdd-specs.md.

**Check method:**
```bash
grep -oE "REQ-[0-9]+" _index.md | sort -u | while read -r id; do
  grep -q "$id" bdd-specs.md || echo "FAIL: $id absent from bdd-specs.md"
done
```
Any "FAIL" output line means REQ-TRACE-01 is FAIL. Empty output means PASS.

**Evidence format:** `requirement ID + absence note`

**Rework format:** "Add {ID} reference to an existing covering scenario or create a new scenario for {ID}: {requirement title}"

**Result:** PASS if every REQ-NNN appears in bdd-specs.md. FAIL otherwise.

`# Type: computational` -- grep for exact ID strings is deterministic.

---

### SCEN-CONC-01 -- All Given clauses use specific data values

**Description:** Every `Given` clause in bdd-specs.md must use concrete, specific data values. Vague placeholders such as "some", "valid", "appropriate", or "relevant" are not permitted.

**Check method:**
```bash
grep -n "Given " bdd-specs.md | grep -iE "\bsome\b|\bvalid\b|\bappropriate\b|\brelevant\b"
```
Any match is FAIL. Zero matches is PASS.

**Evidence format:** `bdd-specs.md:{line} -- "{clause text}"`

**Rework format:** "Replace '{vague phrase}' with concrete value at bdd-specs.md:{line}"

**Result:** PASS if zero matches. FAIL on any match.

`# Type: computational` -- grep against vague-word list produces deterministic match.

---

### ARCH-01 -- No inner-to-outer layer dependencies described

**Description:** architecture.md (or the Detailed Design section in _index.md) must not describe any dependency, import, or reference from an inner architectural layer (Domain, Application) to an outer layer (Infrastructure, Presentation/CLI).

**Check method:** Scan architecture.md for arrows or prose stating an inner layer imports from an outer layer. Patterns: `domain.*infrastructure`, `application.*infrastructure`, `domain.*presentation`. Confirm matches describe an actual dependency direction (not a prohibition such as "domain must NOT import infrastructure").

**Evidence format:** `{file}:{line} -- "{dependency description}"`

**Rework format:** "Invert dependency at {file}:{line}; define interface in inner layer."

**Result:** PASS if no inner-to-outer dependency is described. FAIL on any.

`# Type: inferential` -- grep narrows candidates; evaluator confirms direction vs. prohibition.

---

### RISK-02 -- Each risk mitigation specifies a concrete action

**Description:** Every risk mitigation entry in the Risks section of _index.md must specify a concrete, actionable measure. Vague verbs such as "monitor", "handle", "manage", "address", "deal with", "look into" indicate a non-concrete mitigation when used as the sole action.

**Check method:**
```bash
grep -n -iE "mitigation|mitigate" _index.md | grep -iE "\bmonitor\b|\bhandle\b|\bmanage\b|\baddress\b|\bdeal with\b|\blook into\b"
```
Confirm the flagged verb is the primary action (not a supplement to a concrete measure).

**Evidence format:** `_index.md -- risk "{title}" mitigation "{text}"`

**Rework format:** "Replace vague mitigation for risk '{title}' with concrete action (e.g., specific alert thresholds, retry policy, circuit breaker)."

**Result:** PASS if every mitigation describes a concrete action. FAIL on any vague-only mitigation.

`# Type: inferential` -- vague-verb match is computational; primary-vs-supplement distinction is judgment.

---

## Evaluation Protocol

1. Run each check method against the design artifacts in the plan folder.
2. Record PASS or FAIL for each item.
3. For each FAIL, capture evidence in the specified format and produce a rework item with file, line, and corrective instruction.
4. Verdict: all items PASS = **PASS**. Any item FAIL = **REWORK** with itemized rework list. JUST-01 has verdict precedence: a JUST-01 FAIL produces REWORK regardless of how the content-quality items resolve.
