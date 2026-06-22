---
name: release-precheck
description: Use before merging a kimi-code release PR to verify the changesets it will publish are valid — correct package, appropriate bump level (minor / major / patch), and compliant wording. Outputs the release PR link plus a check table.
---

# Release Precheck

`kimi-code` uses changesets. On every push to `main`, the `Release` workflow opens/updates a release PR titled **`ci: release packages`** (branch `changeset-release/main`); merging it consumes `.changeset/*.md`, bumps versions, and publishes. This skill verifies the changesets in that PR **before** merge.

For authoring a changeset and the full bump / package / wording rules, see `gen-changesets`. All `gh` commands target `MoonshotAI/kimi-code`.

## Key facts

- Released packages: `@moonshot-ai/kimi-code` (CLI) and `@moonshot-ai/kimi-code-sdk` (SDK).
- Ignored packages must **never** appear in frontmatter — see `.changeset/config.json` for the list. They are bundled into the CLI, so a user-visible change in any of them lists `@moonshot-ai/kimi-code` instead.

## Workflow

### 1. Locate the release PR

```bash
gh pr list --state open --search "ci: release packages in:title" \
  --json number,title,url,headRefName,baseRefName
```

Pick the one with `headRefName: changeset-release/main`; record `number`, `url`, `baseRefName` as `<RELEASE>`. If none is open, nothing to release — stop.

### 2. Read the changesets

```bash
gh pr view <RELEASE> --json files --jq '.files[].path' \
  | grep '^\.changeset/.*\.md$' | grep -vE '(^|/)(README|config)\.md$'
```

Read each from the PR's **base** ref (the release PR deletes them; while open they still live on `main`):

```bash
gh api "repos/MoonshotAI/kimi-code/contents/<changeset-path>?ref=<baseRefName>" --jq .content | base64 -d
```

Each has frontmatter (package → bump) and a one-sentence body:

```markdown
---
"@moonshot-ai/kimi-code": minor
---

Add an environment variable to cap AgentSwarm concurrency during the initial ramp.
```

### 3. Check each changeset

1. **Frontmatter.** Parses as YAML; every package is a released package (never an ignored one); bump is one of `major` / `minor` / `patch`; no released package is mixed with an ignored one in the same frontmatter.
2. **Bump level.** `feat` → `minor`; `fix`/`perf`/`refactor`/`chore`/`build`/`style`/`test`/`docs` → `patch`; `!` or `BREAKING CHANGE` → `major`. If the body is too vague to tell, open the source PR (linked in the release PR's changelog) and confirm the level matches the change.
3. **Wording.** English; one short honest sentence; no file/class/function names, PR numbers, or hashes; no real internal endpoints/keys/account/service names (use `example.com`, `example.test`, `YOUR_API_KEY`); no vague `refactor`/`improve`/`optimize` unless the actual change is named.
4. **`major`.** Stop and surface to the user — never decide or downgrade it yourself.

### 4. Output

Be concise; give links directly, write `无` for empty sections.

```
发版 PR: <url or 无>

| Changeset | Package | Bump | Status | Note |
|---|---|---|---|---|
| public-apes-battle | @moonshot-ai/kimi-code | minor | OK | — |
| stale-hounds-beam | @moonshot-ai/kimi-code | patch | Wording | vague "improve" |

阻塞问题: 无
结论: safe to merge   (safe to merge / merge after fixes / hold for confirmation)
```

- `Status` ∈ `OK`, `Invalid frontmatter`, `Wrong package`, `Wrong level`, `Wording`, `Major needs confirmation`. Combine with `+` when needed.
- `阻塞问题`: invalid frontmatter, unconfirmed `major`, leaked internal identifier; otherwise `无`.

## Notes

- Read-only. Never edit a changeset/changelog here; fixes go through a follow-up PR via `gen-changesets`.
- This verifies the changesets present in the release PR. It does not audit whether other merged PRs forgot a changeset — the changesets bot already flags that on each PR.
- Stop and ask the user on any `major` declaration; flag invalid frontmatter or leaked internal identifier as blocking.
