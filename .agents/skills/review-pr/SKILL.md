---
name: review-pr
description: Use when reviewing a pull request in the kimi-code repository — translate the PR template sections into Chinese and evaluate the change against the template structure.
disable-model-invocation: true
---

# Review PR

Review a pull request by evaluating the description against the template and the actual diff, then write a structured review summary in Chinese.

## Workflow

1. Fetch the PR description and metadata:

   ```bash
   gh pr view <number> --json title,body,url,files,additions,deletions,baseRefName,headRefName
   ```

2. Read the full diff:

   ```bash
   gh pr diff <number>
   ```

3. Read enough surrounding code to verify the claims in the PR description.

4. Evaluate each section against the criteria below.

5. Write the review summary in Chinese.

## Section Translation

Use these translated names in the review summary:

| English | 中文 |
|---------|------|
| Requirement or Bug | 需求或 Bug |
| Bug Reproduction Steps | Bug 复现步骤 |
| Root Cause | 根本原因 |
| Code Changes | 代码变更 |
| Impact Scope | 影响范围 |
| Checklist | 检查清单 |

## Review Criteria

### 需求或 Bug

- Is the linked issue valid and relevant?
- If no issue, is the requirement clearly stated in one or two sentences?

### Bug 复现步骤

- For bug PRs: are the steps clear and reproducible?
- Can you follow the steps to confirm the bug exists on the base branch?

### 根本原因

- For bug PRs: is the root cause convincingly explained?
- Does the stated root cause match what you see in the diff?
- Is it clear whether this is a fundamental fix or a workaround?

### 代码变更

- Does the description match the actual diff?
- Are visual outlines (diff blocks, call trees, file trees) accurate and helpful?
- Is the approach sound? Are there simpler alternatives?
- Are there edge cases the author missed?

### 影响范围

- Are all affected modules identified? Cross-check with the diff file list.
- Does test coverage match the claimed scope?
- Are there untested paths that carry risk?

### 检查清单

- Are all applicable items checked?
- For items marked as "not needed", do you agree?

## Output

Write the review summary in Chinese. For each section:

- State whether it is adequately filled in.
- Flag anything missing, inaccurate, or inconsistent with the diff.
- If the PR is ready, say so. If changes are needed, list them as actionable items.
