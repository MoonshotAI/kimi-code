---
name: github-release
description: >
  Create a GitHub Release for a tag using the REST API. Handles the full release workflow
  including tag selection, changelog extraction from docs, and publishing.
  Use when the user wants to create a GitHub release, publish a release, release a tag,
  or says "create release" or "发布到 GitHub" or "GitHub release".
metadata:
  short-description: "Create a GitHub Release via GitHub REST API"
---

# GitHub Release

Create a GitHub Release for a given tag, extracting the changelog from the project's
`docs/en/release-notes/changelog.md` for the release body.

## Workflow

### Step 1: Determine the tag and repo info

Ask the user or auto-detect:
- **GitHub repo**: read from `git remote get-url origin`, extract `owner/repo` from the URL.
- **Tag name**: ask the user which tag to release (e.g. `v0.23.6` or `@moonshot-ai/kimi-code@0.23.6`).
- **Token**: the user's GitHub Personal Access Token (PAT) with `repo` scope. Read from the
  `GITHUB_TOKEN` environment variable if they've set it. Otherwise ask. NEVER store the
  token in any file — use it in-memory only.

### Step 2: Extract the changelog

Read `docs/en/release-notes/changelog.md`, find the section matching the version,
and extract from the `## 0.x.x` header down to the next `## ` header.

Format the extracted text as GitHub-flavored markdown (keep headings, bullet lists).

If the user wants Chinese content, also extract from `docs/zh/release-notes/changelog.md`.

### Step 3: Confirm before creating

Show the user:
- Tag name
- Release title (e.g. `v0.23.6`)
- First ~300 characters of the body as preview

Ask for confirmation before proceeding.

### Step 4: Create the release via GitHub REST API

```powershell
$body = @{
  tag_name = "<TAG>"
  name = "<TITLE>"
  body = "<CHANGELOG>"
  draft = $false
} | ConvertTo-Json -Compress

Invoke-WebRequest -UseBasicParsing `
  -Uri "https://api.github.com/repos/<OWNER>/<REPO>/releases" `
  -Method POST `
  -Headers @{ Authorization = "token <TOKEN>"; Accept = "application/vnd.github+json" } `
  -Body $body `
  -ContentType "application/json"
```

On success (HTTP 201), tell the user the release URL:
`https://github.com/<OWNER>/<REPO>/releases/tag/<TAG>`

On failure, read the error from the JSON response and report it.

## Important notes

- **Never** write the token to any file or commit it. Use it from env var or ask each time.
- The tag MUST already exist on the remote (pushed). If not, push first.
- For the kimi-code project, the tag format is `@moonshot-ai/kimi-code@<version>`.
- `Invoke-WebRequest -UseBasicParsing` works on Windows without IE engine dependency.
- The body must be a single string — replace newlines with `\n` when putting in JSON.
