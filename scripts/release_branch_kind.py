#!/usr/bin/env python3
"""判定 release/YYYY-MM-DD 分支性质：hotfix 补丁 / weekly 例行 / unknown。

回同步 PR 全是 squash 合入、main 不含 tag commit——单看 merge-base 永不命中
补丁分支，故 judge() 在主判据（merge-base 命中 tag commit）之外还有回退判据。
unknown 绝不猜成别的。

用法：release_branch_kind.py --repo MoonshotAI/kimi-code --branch release/2026-10-23 --format json
退出码：0 = hotfix/weekly；2 = unknown（stderr 写明原因）。凭证：GH_TOKEN。
缓存：--cache-dir 按分支 HEAD 缓存判定（release 分支不 rebase，HEAD 不变永久有效）。
"""
import argparse
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.github.com"
TZ = datetime.timezone(datetime.timedelta(hours=8))
MAX_TAGS = 30          # 近期正式 release 候选上限
TAG_DAYS = 60          # 候选 tag 发布时间窗口（天）；补丁基底一定是近期线上版本


class KindError(Exception):
    """判定失败 → unknown。"""


def now_iso():
    return datetime.datetime.now(TZ).isoformat(timespec="seconds")


def gh_api(path, token, retries=1):
    """GET GitHub API。404 返回 None；其他失败抛 KindError。"""
    url = f"{API}/{path}"
    last = None
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {token}",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "release-branch-kind",
            })
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            last = f"HTTP {e.code} {url}"
        except Exception as e:  # 网络层错误
            last = f"{type(e).__name__}: {e}"
        if i < retries:
            time.sleep(1)
    raise KindError(last or "request failed")


def branch_head(repo, branch, token):
    data = gh_api(f"repos/{repo}/branches/{urllib.parse.quote(branch, safe='')}", token)
    if not isinstance(data, dict):
        raise KindError(f"branch not found: {repo}#{branch}")
    sha = ((data.get("commit") or {}).get("sha"))
    if not sha:
        raise KindError(f"branch has no commit sha: {repo}#{branch}")
    return sha


def merge_base(repo, base, branch, token):
    data = gh_api(
        f"repos/{repo}/compare/{urllib.parse.quote(base, safe='')}...{urllib.parse.quote(branch, safe='')}",
        token,
    )
    if not isinstance(data, dict):
        raise KindError(f"compare failed: {base}...{branch}")
    sha = ((data.get("merge_base_commit") or {}).get("sha"))
    if not sha:
        raise KindError(f"no merge_base_commit: {base}...{branch}")
    return sha


def is_ancestor(repo, tag_commit, branch, token):
    """tag_commit 是否为 branch 祖先（compare 状态 ahead/identical）。"""
    data = gh_api(f"repos/{repo}/compare/{tag_commit}...{urllib.parse.quote(branch, safe='')}", token)
    if not isinstance(data, dict):
        return False
    return data.get("status") in ("ahead", "identical")


def resolve_tag_commit(repo, tag, token):
    """tag 名 → commit sha（annotated tag 解引用一层）。"""
    ref = gh_api(f"repos/{repo}/git/ref/tags/{urllib.parse.quote(tag, safe='')}", token)
    if not isinstance(ref, dict):
        return None
    obj = ref.get("object") or {}
    if obj.get("type") == "commit":
        return obj.get("sha")
    if obj.get("type") == "tag" and obj.get("sha"):
        t = gh_api(f"repos/{repo}/git/tags/{obj['sha']}", token)
        if isinstance(t, dict) and (t.get("object") or {}).get("type") == "commit":
            return t["object"]["sha"]
    return None


def official_releases(repo, token):
    """近期非 prerelease 非 draft 的正式 release，新→旧：[{tag, published_at}]。
    canary 预发布占大头，正式版可能被挤出第一页——按 created_at 翻页到窗口之外。"""
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=TAG_DAYS)
    out = []
    for page in range(1, 6):
        rels = gh_api(f"repos/{repo}/releases?per_page=100&page={page}", token)
        if not isinstance(rels, list):
            if page == 1:
                raise KindError(f"releases list failed: {repo}")
            break
        for r in rels:
            if r.get("prerelease") or r.get("draft"):
                continue
            pub = r.get("published_at")
            tag = r.get("tag_name")
            if not pub or not tag:
                continue
            try:
                dt = datetime.datetime.fromisoformat(pub.replace("Z", "+00:00"))
            except Exception:
                continue
            if dt < cutoff:
                continue
            out.append({"tag": tag, "published_at": pub})
        oldest = None
        if rels:
            try:
                oldest = datetime.datetime.fromisoformat(
                    rels[-1].get("created_at", "").replace("Z", "+00:00"))
            except Exception:
                pass
        if len(rels) < 100 or (oldest and oldest < cutoff) or len(out) >= MAX_TAGS:
            break
    out.sort(key=lambda x: x["published_at"], reverse=True)
    return out[:MAX_TAGS]


def own_release_commits(repo, branch, token):
    """本分支版本 PR 产出的 merge_commit_sha 集合——是「自己的产出」不是基底，判 hotfix 时排除。"""
    owner = repo.split("/", 1)[0]
    prs = gh_api(
        f"repos/{repo}/pulls?state=all&head={owner}:changeset-release/{urllib.parse.quote(branch, safe='')}&per_page=10",
        token,
    )
    if not isinstance(prs, list):
        return set()
    return {p.get("merge_commit_sha") for p in prs if p.get("merged_at") and p.get("merge_commit_sha")}


def judge(repo, branch, base, token):
    """完整判定流程，返回结果 dict（kind 为 hotfix/weekly）。"""
    head = branch_head(repo, branch, token)  # 不存在 → KindError → unknown
    mb = merge_base(repo, base, branch, token)
    result = {
        "repo": repo,
        "branch": branch,
        "kind": None,
        "merge_base_sha": mb,
        "base_tag": None,
        "head_sha": head,
        "checked_at": now_iso(),
    }

    rels = official_releases(repo, token)
    # 解析 tag commit（按发布新→旧惰性解析）
    resolved = []  # [{tag, commit}]
    for r in rels:
        c = resolve_tag_commit(repo, r["tag"], token)
        if c:
            resolved.append({"tag": r["tag"], "commit": c})

    # 主判据：merge-base 命中 tag commit
    for t in resolved:
        if t["commit"] == mb:
            result["kind"] = "hotfix"
            result["base_tag"] = t["tag"]
            return result

    # 回退判据（squash 回同步下主判据永不命中）：tag 是分支祖先、非 main 祖先、非本分支版本 PR 产出
    own = own_release_commits(repo, branch, token)
    for t in resolved:  # resolved 已按发布新→旧排序，首个命中即最近基底
        if t["commit"] in own:
            continue
        if is_ancestor(repo, t["commit"], base, token):
            continue
        if is_ancestor(repo, t["commit"], branch, token):
            result["kind"] = "hotfix"
            result["base_tag"] = t["tag"]
            return result

    result["kind"] = "weekly"
    return result


def cache_path(cache_dir, repo, branch):
    name = (repo + "__" + branch).replace("/", "_")
    return os.path.join(cache_dir, name + ".json")


def read_cache(cache_dir, repo, branch, head):
    try:
        with open(cache_path(cache_dir, repo, branch), encoding="utf-8") as f:
            data = json.load(f)
        if data.get("head_sha") == head and isinstance(data.get("result"), dict):
            if data["result"].get("kind") in ("hotfix", "weekly"):
                return data["result"]
    except Exception:
        pass
    return None


def write_cache(cache_dir, repo, branch, head, result):
    try:
        os.makedirs(cache_dir, exist_ok=True)
        tmp = cache_path(cache_dir, repo, branch) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"head_sha": head, "result": result}, f, ensure_ascii=False, indent=2)
        os.replace(tmp, cache_path(cache_dir, repo, branch))
    except Exception:
        pass  # 缓存失败不影响判定


def main():
    ap = argparse.ArgumentParser(description="判定 release 分支性质（hotfix/weekly/unknown）")
    ap.add_argument("--repo", required=True, help="owner/name，如 MoonshotAI/kimi-code")
    ap.add_argument("--branch", required=True, help="如 release/2026-10-23")
    ap.add_argument("--base", default="main", help="主判据对照分支（默认 main）")
    ap.add_argument("--format", choices=("json", "text"), default="json")
    ap.add_argument("--cache-dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache"))
    ap.add_argument("--no-cache", action="store_true", help="跳过缓存强制重判")
    args = ap.parse_args()

    token = os.environ.get("GH_TOKEN")
    if not token:
        print("GH_TOKEN not set", file=sys.stderr)
        emit(args, {"repo": args.repo, "branch": args.branch, "kind": "unknown",
                    "merge_base_sha": None, "base_tag": None, "head_sha": None,
                    "checked_at": now_iso(), "reason": "GH_TOKEN not set"})
        return 2

    try:
        head = branch_head(args.repo, args.branch, token)
    except KindError as e:
        print(str(e), file=sys.stderr)
        emit(args, {"repo": args.repo, "branch": args.branch, "kind": "unknown",
                    "merge_base_sha": None, "base_tag": None, "head_sha": None,
                    "checked_at": now_iso(), "reason": str(e)})
        return 2

    if not args.no_cache:
        cached = read_cache(args.cache_dir, args.repo, args.branch, head)
        if cached:
            print(f"cache hit (head {head[:8]})", file=sys.stderr)
            emit(args, cached)
            return 0

    try:
        result = judge(args.repo, args.branch, args.base, token)
    except KindError as e:
        print(str(e), file=sys.stderr)
        emit(args, {"repo": args.repo, "branch": args.branch, "kind": "unknown",
                    "merge_base_sha": None, "base_tag": None, "head_sha": head,
                    "checked_at": now_iso(), "reason": str(e)})
        return 2

    write_cache(args.cache_dir, args.repo, args.branch, head, result)
    emit(args, result)
    return 0


def emit(args, result):
    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False))
    else:
        bt = f" base_tag={result['base_tag']}" if result.get("base_tag") else ""
        mb = (result.get("merge_base_sha") or "?")[:8]
        print(f"{result['kind']} repo={result['repo']} branch={result['branch']} merge_base={mb}{bt}")


if __name__ == "__main__":
    sys.exit(main())
