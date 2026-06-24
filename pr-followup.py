#!/usr/bin/env python3
"""
PR Follow-up: 轮询 PR review comment，直到全部 resolve。
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

STATE_FILE = "/tmp/openclaw/pr-followup-state.json"
REPO = "MoonshotAI/kimi-code"

def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    return {"pr_states": {}, "last_run": None}

def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)

def run_cmd(cmd, check=True):
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if result.returncode != 0 and check:
        print(f"Error running: {cmd}")
        print(f"stderr: {result.stderr}", file=sys.stderr)
        return None
    return result.stdout.strip()

def get_open_prs():
    """获取当前用户提的 open PR 列表"""
    cmd = (
        f'gh pr list --repo {REPO} --author "@me" --state open '
        f'--json number,title,url,reviewDecision,createdAt,updatedAt --limit 20'
    )
    output = run_cmd(cmd)
    if not output:
        return []
    return json.loads(output)

def get_pr_review_threads(pr_number):
    """
    使用 GitHub GraphQL API 获取 PR 的 review threads 及其 resolved 状态。
    返回 list of dict: [{"isResolved": bool, "comments": [...], "id": str}]
    """
    query = f'''query {{
      repository(owner: "MoonshotAI", name: "kimi-code") {{
        pullRequest(number: {pr_number}) {{
          reviewThreads(first: 100) {{
            nodes {{
              id
              isResolved
              comments(first: 100) {{
                nodes {{
                  id
                  body
                  author {{
                    login
                  }}
                  createdAt
                }}
              }}
            }}
          }}
        }}
      }}
    }}'''
    
    import tempfile
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
        json.dump({"query": query}, f)
        tmpfile = f.name
    
    try:
        # Use --input to pass JSON payload
        cmd = f'gh api graphql --input "{tmpfile}"'
        output = run_cmd(cmd, check=False)
        if not output:
            return []
        data = json.loads(output)
        if "errors" in data:
            print(f"GraphQL errors: {data['errors']}", file=sys.stderr)
            return []
        
        threads = data.get("data", {}).get("repository", {}).get("pullRequest", {}).get("reviewThreads", {}).get("nodes", [])
        return threads
    finally:
        os.unlink(tmpfile)

def get_pr_reviews(pr_number):
    """获取 PR 的 reviews 列表"""
    cmd = f'gh pr view {pr_number} --repo {REPO} --json reviews'
    output = run_cmd(cmd, check=False)
    if not output:
        return []
    data = json.loads(output)
    return data.get("reviews", [])

def analyze_pr(pr_number, pr_title, pr_url):
    """分析 PR 状态，返回 (needs_action, notification_msg, new_state)"""
    threads = get_pr_review_threads(pr_number)
    reviews = get_pr_reviews(pr_number)
    
    total_threads = len(threads)
    unresolved_threads = [t for t in threads if not t.get("isResolved", False)]
    unresolved_count = len(unresolved_threads)
    
    # 统计所有 comments
    all_comments = []
    for t in threads:
        for c in t.get("comments", {}).get("nodes", []):
            all_comments.append({
                "author": c.get("author", {}).get("login", "unknown"),
                "body": c.get("body", "")[:100] + "..." if len(c.get("body", "")) > 100 else c.get("body", ""),
            })
    
    # 构建状态快照
    state_snapshot = {
        "total_threads": total_threads,
        "unresolved_count": unresolved_count,
        "review_count": len(reviews),
        "comment_count": len(all_comments),
        "unresolved_authors": list(set(t.get("comments", {}).get("nodes", [{}])[0].get("author", {}).get("login", "unknown") for t in unresolved_threads)) if unresolved_threads else [],
    }
    
    # 构建通知消息
    lines = []
    header = f"PR #{pr_number}: {pr_title}"
    lines.append(header)
    lines.append(pr_url)
    
    if unresolved_count > 0:
        lines.append(f"\n⚠️ **{unresolved_count} 个未 resolved 的 review thread**（共 {total_threads} 个）")
        for t in unresolved_threads:
            first_comment = t.get("comments", {}).get("nodes", [{}])[0]
            author = first_comment.get("author", {}).get("login", "unknown")
            body = first_comment.get("body", "")[:80] + "..." if len(first_comment.get("body", "")) > 80 else first_comment.get("body", "")
            lines.append(f"  - @{author}: {body}")
    elif total_threads > 0:
        lines.append(f"\n✅ **全部 {total_threads} 个 review thread 已 resolved！**")
    else:
        lines.append("\n⏳ 暂无 review threads")
    
    # 如果有 reviews（包括 APPROVED/CHANGES_REQUESTED/COMMENTED）
    if reviews:
        lines.append(f"\n📋 Reviews 状态:")
        for r in reviews:
            state = r.get("state", "UNKNOWN")
            author = r.get("author", {}).get("login", "unknown")
            lines.append(f"  - @{author}: {state}")
    
    needs_action = unresolved_count > 0
    msg = "\n".join(lines)
    return needs_action, msg, state_snapshot

def should_notify(current_state, old_state):
    """判断是否需要通知（关键指标变化）"""
    if old_state is None:
        return True
    if current_state["unresolved_count"] != old_state.get("unresolved_count"):
        return True
    if current_state["total_threads"] != old_state.get("total_threads"):
        return True
    if current_state["review_count"] != old_state.get("review_count"):
        return True
    return False

def main():
    state = load_state()
    now = datetime.now(timezone.utc).isoformat()
    state["last_run"] = now
    
    prs = get_open_prs()
    if not prs:
        print("没有 open 的 PR")
        state["pr_states"] = {}
        save_state(state)
        return
    
    notifications = []
    current_numbers = set()
    
    for pr in prs:
        number = str(pr["number"])
        current_numbers.add(number)
        
        needs_action, msg, snapshot = analyze_pr(pr["number"], pr["title"], pr["url"])
        old_state = state["pr_states"].get(number)
        
        if should_notify(snapshot, old_state):
            notifications.append(msg)
        
        state["pr_states"][number] = {
            **snapshot,
            "last_notified": now if should_notify(snapshot, old_state) else (old_state or {}).get("last_notified", now),
            "pr_title": pr["title"],
            "pr_url": pr["url"],
        }
    
    # 清理已 merged/closed 的 PR
    removed = []
    for number in list(state["pr_states"].keys()):
        if number not in current_numbers:
            removed.append(number)
            del state["pr_states"][number]
    
    if removed:
        print(f"已移除 closed PR: {removed}")
    
    save_state(state)
    
    # 输出通知
    if notifications:
        print("\n=== NOTIFICATIONS ===\n")
        for msg in notifications:
            print(msg)
            print("\n---\n")
    else:
        print("没有状态变化，无需通知")

if __name__ == "__main__":
    main()
