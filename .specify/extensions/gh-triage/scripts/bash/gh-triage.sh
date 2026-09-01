#!/usr/bin/env bash
#
# gh-triage engine
# -----------------
# Deterministic, dependency-light engine backing the `speckit.gh-triage.triage`
# command. It fetches open GitHub issues for a repo, classifies each as
# bug / feature / chore / unknown, and (by default) labels each issue with the
# correct triage labels read directly from the extension config.
#
# The "route to workflow" step (bug -> speckit.bug.assess, feature ->
# speckit.specify) is performed by the agent following the command markdown;
# this script owns fetch + classify + label only, so each phase is testable in
# isolation.
#
# Usage:
#   gh-triage.sh [run|list|classify|label|feature] [options]
#
# Subcommands:
#   run       (default) fetch, classify, and label issues (respects auto_label)
#   list      print open issues as JSON and exit (no classify/label)
#   classify  fetch + classify, print the triage plan, do NOT label
#   label     alias for `run`
#   feature   create a GitHub issue describing a new feature (no classify/label)
#
# Options (shared):
#   --repo OWNER/REPO   override the repo (else config.repo, else git remote)
#   --config PATH       path to gh-triage-config.yml
#   --json              emit machine-readable output (JSON)
#
# Options (triage only):
#   --limit N           max issues to triage (0 = all)
#   --issue N           triage a single issue number instead of the open list
#   --dry-run           classify + report labels, but do not apply them
#
# Options (feature only):
#   --title "<t>"       feature issue title (required)
#   --body "<b>"        feature issue body (defaults to the title)
#   --label "<l>"       label to apply (default: config labels.feature; "" = none)
#
# Dependencies: gh (GitHub CLI, authenticated), jq. No yq/PyYAML required.

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults (overridden by config where present)
# ---------------------------------------------------------------------------
DEF_AUTO_LABEL="true"
DEF_REPO=""
DEF_LIMIT="0"
DEF_LABELS_BUG="bug"
DEF_LABELS_FEATURE="enhancement"
DEF_LABELS_CHORE="chore"
DEF_LABELS_NEEDS_TRIAGE=""
DEF_LABELS_INVALID="invalid"
DEF_SEV_CRITICAL="severity:critical"
DEF_SEV_HIGH="severity:high"
DEF_SEV_MEDIUM="severity:medium"
DEF_SEV_LOW="severity:low"
DEF_SEV_UNKNOWN=""
DEF_BUG_KEYWORDS="crash error exception traceback broken regression fails bug stack trace leak hang deadlock freeze corrupt panic"
DEF_FEATURE_KEYWORDS="feature enhancement request proposal add support idea suggestion want"
DEF_CHORE_KEYWORDS="chore cleanup refactor maintenance tech debt dependency bump migrate migration housekeeping branding asset swap rename update logos swap"

# Active values (filled from config)
AUTO_LABEL="$DEF_AUTO_LABEL"
CFG_REPO="$DEF_REPO"
CFG_LIMIT="$DEF_LIMIT"
LABELS_BUG="$DEF_LABELS_BUG"
LABELS_FEATURE="$DEF_LABELS_FEATURE"
LABELS_CHORE="$DEF_LABELS_CHORE"
LABELS_NEEDS_TRIAGE="$DEF_LABELS_NEEDS_TRIAGE"
LABELS_INVALID="$DEF_LABELS_INVALID"
SEV_CRITICAL="$DEF_SEV_CRITICAL"
SEV_HIGH="$DEF_SEV_HIGH"
SEV_MEDIUM="$DEF_SEV_MEDIUM"
SEV_LOW="$DEF_SEV_LOW"
SEV_UNKNOWN="$DEF_SEV_UNKNOWN"
BUG_KEYWORDS="$DEF_BUG_KEYWORDS"
FEATURE_KEYWORDS="$DEF_FEATURE_KEYWORDS"
CHORE_KEYWORDS="$DEF_CHORE_KEYWORDS"

# ---------------------------------------------------------------------------
# CLI parsing
# ---------------------------------------------------------------------------
SUBCMD="run"
ARG_REPO=""
ARG_LIMIT=""
ARG_ISSUE=""
ARG_CONFIG=""
ARG_TITLE=""
ARG_BODY=""
ARG_LABEL=""
DRY_RUN="false"
AS_JSON="false"

while [ $# -gt 0 ]; do
  case "$1" in
    run|list|classify|label|feature) SUBCMD="$1" ;;
    --repo) ARG_REPO="${2:-}"; shift ;;
    --limit) ARG_LIMIT="${2:-}"; shift ;;
    --issue) ARG_ISSUE="${2:-}"; shift ;;
    --config) ARG_CONFIG="${2:-}"; shift ;;
    --title) ARG_TITLE="${2:-}"; shift ;;
    --body) ARG_BODY="${2:-}"; shift ;;
    --label) ARG_LABEL="${2:-}"; shift ;;
    --dry-run) DRY_RUN="true" ;;
    --json) AS_JSON="true" ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "gh-triage: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift || true
done

[ "$SUBCMD" = "label" ] && SUBCMD="run"
[ "$SUBCMD" = "classify" ] && DRY_RUN="true"

# ---------------------------------------------------------------------------
# Config loading (minimal, dependency-free YAML reader via awk)
# ---------------------------------------------------------------------------
resolve_config_path() {
  if [ -n "$ARG_CONFIG" ]; then
    echo "$ARG_CONFIG"; return
  fi
  local p=".specify/extensions/gh-triage/gh-triage-config.yml"
  if [ -f "$p" ]; then echo "$p"; return; fi
  echo ""
}

load_config() {
  local cfg_path
  cfg_path="$(resolve_config_path)"
  [ -z "$cfg_path" ] && return 0

  # Portable awk: handles top-level scalars, one level of nested map, and
  # simple "- item" lists. Emits CFG_* shell assignments.
  local parsed
  parsed="$(awk '
    {
      line=$0
      sub(/\r$/,"",line)
      n=length(line)
      sub(/^ */,"",line)
      ind=n-length(line)
      sub(/[ \t]#.*$/,"",line)   # strip inline comment (space-hash only)
      if (line=="") next
      if (substr(line,1,1)=="#") next
      # list item
      if (substr(line,1,2)=="- ") {
        val=substr(line,3)
        if (substr(val,1,1)=="\"" && substr(val,length(val),1)=="\"") val=substr(val,2,length(val)-2)
        if (container=="bug_keywords") BK=BK " " val
        else if (container=="feature_keywords") FK=FK " " val
        else if (container=="chore_keywords") CK=CK " " val
        next
      }
      # key: value
      c=index(line,":")
      if (c>0) {
        key=substr(line,1,c-1)
        val=substr(line,c+1)
        sub(/^[ \t]+/,"",val); sub(/[ \t]+$/,"",val)
        rawval=val
        if (rawval=="\"" "\"" || rawval=="'" "'") { val="" }
        else if (substr(val,1,1)=="\"" && substr(val,length(val),1)=="\"") { val=substr(val,2,length(val)-2) }
        gsub(/[^a-zA-Z0-9_]/,"_",key)
        if (val=="") { container=key; next }
        if (ind==0) { print "CFG_" key "=\"" val "\"" }
        else { cc=container; gsub(/[^a-zA-Z0-9_]/,"_",cc); print "CFG_" cc "_" key "=\"" val "\"" }
        next
      }
    }
    END {
      if (BK!="") print "CFG_BUG_KEYWORDS=\"" substr(BK,2) "\""
      if (FK!="") print "CFG_FEATURE_KEYWORDS=\"" substr(FK,2) "\""
      if (CK!="") print "CFG_CHORE_KEYWORDS=\"" substr(CK,2) "\""
    }
  ' "$cfg_path")"

  # shellcheck disable=SC1090
  [ -n "$parsed" ] && eval "$parsed"

  [ -n "${CFG_auto_label:-}" ] && AUTO_LABEL="$CFG_auto_label"
  [ -n "${CFG_repo:-}" ] && CFG_REPO="$CFG_repo"
  [ -n "${CFG_limit:-}" ] && CFG_LIMIT="$CFG_limit"
  [ -n "${CFG_labels_bug:-}" ] && LABELS_BUG="$CFG_labels_bug"
  [ -n "${CFG_labels_feature:-}" ] && LABELS_FEATURE="$CFG_labels_feature"
  [ -n "${CFG_labels_chore:-}" ] && LABELS_CHORE="$CFG_labels_chore"
  [ -n "${CFG_labels_needs_triage:-}" ] && LABELS_NEEDS_TRIAGE="$CFG_labels_needs_triage"
  [ -n "${CFG_labels_invalid:-}" ] && LABELS_INVALID="$CFG_labels_invalid"
  [ -n "${CFG_severity_labels_critical:-}" ] && SEV_CRITICAL="$CFG_severity_labels_critical"
  [ -n "${CFG_severity_labels_high:-}" ] && SEV_HIGH="$CFG_severity_labels_high"
  [ -n "${CFG_severity_labels_medium:-}" ] && SEV_MEDIUM="$CFG_severity_labels_medium"
  [ -n "${CFG_severity_labels_low:-}" ] && SEV_LOW="$CFG_severity_labels_low"
  [ -n "${CFG_severity_labels_unknown:-}" ] && SEV_UNKNOWN="$CFG_severity_labels_unknown"
  [ -n "${CFG_BUG_KEYWORDS:-}" ] && BUG_KEYWORDS="$CFG_BUG_KEYWORDS"
  [ -n "${CFG_FEATURE_KEYWORDS:-}" ] && FEATURE_KEYWORDS="$CFG_FEATURE_KEYWORDS"
  [ -n "${CFG_CHORE_KEYWORDS:-}" ] && CHORE_KEYWORDS="$CFG_CHORE_KEYWORDS"
  return 0
}

# ---------------------------------------------------------------------------
# Repo resolution
# ---------------------------------------------------------------------------
parse_github_url() {
  local u="$1"
  u="${u#*://}"            # drop scheme
  u="${u#git@}"            # drop git@ (scp form)
  u="${u/:/\/}"            # first ':' -> '/'  (scp form -> path form)
  u="${u%.git}"            # drop trailing .git
  case "$u" in
    *github.com/*) u="${u#*github.com/}" ;;
  esac
  echo "$u"
}

resolve_repo() {
  if [ -n "$ARG_REPO" ]; then REPO="$ARG_REPO"; return; fi
  if [ -n "$CFG_REPO" ]; then REPO="$CFG_REPO"; return; fi
  local url
  url="$(git config --get remote.origin.url 2>/dev/null || true)"
  if [ -z "$url" ]; then echo "gh-triage: cannot determine repo (no --repo, empty config.repo, no git remote)" >&2; exit 1; fi
  REPO="$(parse_github_url "$url")"
  if [ -z "$REPO" ] || [ "$REPO" = "$url" ]; then
    echo "gh-triage: git remote does not point to github.com: $url" >&2; exit 1
  fi
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
require_gh() {
  if ! command -v gh >/dev/null 2>&1; then echo "gh-triage: 'gh' CLI not found" >&2; exit 1; fi
  if ! gh auth status >/dev/null 2>&1; then echo "gh-triage: 'gh' is not authenticated (run: gh auth login)" >&2; exit 1; fi
}

# Fetch the set of valid label names for the repo (JSON array -> space string)
fetch_repo_labels() {
  gh label list --repo "$REPO" --json name --limit 1000 2>/dev/null \
    | jq -r '.[].name' 2>/dev/null | tr '\n' ' ' || true
}

label_exists() {
  # $1 = label name, $2 = space-separated repo label set
  case " $2 " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

# Classify one issue. Echoes: "<number>|<verdict>|<severity>|<labels_to_add_csv>"
classify_and_plan() {
  local num="$1" title="$2" body="$3" existing="$4" repolabels="$5"
  local text lower
  text="$title $body"
  lower="$(printf '%s' "$text" | tr '[:upper:]' '[:lower:]')"

  local verdict="unknown"
  # 1) honor an existing classification label
  case " $existing " in
    *" bug "*) verdict="bug" ;;
    *" enhancement "*) verdict="feature" ;;
    *" feature "*) verdict="feature" ;;
    *" chore "*) verdict="chore" ;;
  esac

  # Keyword test against the lowercased text.
  #  - Multi-word keywords ("add support") match as an exact phrase only.
  #  - Single-word keywords ("crash") match a whole word OR a word that
  #    *starts* with the keyword ("crashes", "crashing"), so inflections are
  #    caught -- but "low" must NOT match "workflow" and "bug" must NOT match
  #    "debug" (those are not prefixes of the longer word).
  text_has() {
    local kw="$1"
    if printf '%s' "$lower" | grep -qwF -- "$kw"; then return 0; fi
    case "$kw" in
      *" "*) return 1 ;;  # multi-word: exact phrase only
    esac
    printf '%s' "$lower" | grep -qE "(^|[^a-z])$kw" 
  }

  # 2) keyword hints when no classification label present
  if [ "$verdict" = "unknown" ]; then
    for kw in $BUG_KEYWORDS; do
      if text_has "$kw"; then verdict="bug"; break; fi
    done
  fi
  if [ "$verdict" = "unknown" ]; then
    for kw in $FEATURE_KEYWORDS; do
      if text_has "$kw"; then verdict="feature"; break; fi
    done
  fi
  if [ "$verdict" = "unknown" ]; then
    for kw in $CHORE_KEYWORDS; do
      if text_has "$kw"; then verdict="chore"; break; fi
    done
  fi

  # 3) severity
  local severity="unknown"
  case " $existing " in
    *" severity:critical "*) severity="critical" ;;
    *" severity:high "*) severity="high" ;;
    *" severity:medium "*) severity="medium" ;;
    *" severity:low "*) severity="low" ;;
  esac
  if [ "$severity" = "unknown" ]; then
    if text_has "critical" || text_has "fatal"; then severity="critical"
    elif text_has "high"; then severity="high"
    elif text_has "medium"; then severity="medium"
    elif text_has "low"; then severity="low"
    fi
  fi

  # 4) build labels_to_add
  local add=""
  case "$verdict" in
    bug)
      [ -n "$LABELS_BUG" ] && add="$add $LABELS_BUG"
      [ "$severity" = "critical" ] && [ -n "$SEV_CRITICAL" ] && add="$add $SEV_CRITICAL"
      [ "$severity" = "high" ] && [ -n "$SEV_HIGH" ] && add="$add $SEV_HIGH"
      [ "$severity" = "medium" ] && [ -n "$SEV_MEDIUM" ] && add="$add $SEV_MEDIUM"
      [ "$severity" = "low" ] && [ -n "$SEV_LOW" ] && add="$add $SEV_LOW"
      ;;
    feature)
      [ -n "$LABELS_FEATURE" ] && add="$add $LABELS_FEATURE"
      ;;
    chore)
      [ -n "$LABELS_CHORE" ] && add="$add $LABELS_CHORE"
      ;;
    unknown)
      # Unknown == not confidently a bug or feature. Route to a human review
      # label (needs_triage) rather than asserting "invalid"; we never
      # auto-flag an issue as invalid from a heuristic.
      [ -n "$LABELS_NEEDS_TRIAGE" ] && add="$add $LABELS_NEEDS_TRIAGE"
      ;;
  esac

  # 5) drop labels already present / not in repo
  local final=""
  for lbl in $add; do
    case " $existing " in *" $lbl "*) continue ;; esac   # already on issue
    if ! label_exists "$lbl" "$repolabels"; then
      echo "  ! skip label '$lbl' (not present in repo $REPO)" >&2
      continue
    fi
    final="$final $lbl"
  done
  final="$(printf '%s' "$final" | sed 's/^ //;s/ /,/g')"

  echo "$num|$verdict|$severity|$final"
}

apply_labels() {
  # $1 = number, $2 = comma-separated labels
  local num="$1" labels="$2"
  [ -z "$labels" ] && return 0
  local IFS=','
  for lbl in $labels; do
    if [ "$DRY_RUN" = "true" ]; then
      echo "  ~ would label #$num: $lbl"
    else
      if gh issue edit "$num" --repo "$REPO" --add-label "$lbl" >/dev/null 2>&1; then
        echo "  + labeled #$num: $lbl"
      else
        echo "  ! failed to label #$num: $lbl" >&2
      fi
    fi
  done
}

# ---------------------------------------------------------------------------
# Feature issue creation
# ---------------------------------------------------------------------------
# Create a GitHub issue describing a new feature. The deterministic issue
# creation (gh issue create) happens here; the optional downstream "turn this
# into a spec" step is performed by the agent following the command markdown
# (it calls speckit.specify), so this subcommand stays testable in isolation.
feature_create() {
  require_gh
  load_config
  resolve_repo

  local title="$ARG_TITLE" body="$ARG_BODY"
  if [ -z "$title" ]; then
    echo "gh-triage feature: --title is required" >&2
    exit 2
  fi
  [ -z "$body" ] && body="$title"

  # Pick the label: explicit --label wins; else config labels.feature; "" disables.
  local label="${ARG_LABEL:-$LABELS_FEATURE}"

  # Only apply the label if it actually exists in the target repo (never
  # force-create labels, matching the triage engine's behavior).
  if [ -n "$label" ]; then
    local repolabels="$(fetch_repo_labels)"
    if ! label_exists "$label" "$repolabels"; then
      echo "  ! skip label '$label' (not present in repo $REPO)" >&2
      label=""
    fi
  fi

  local args=(issue create --repo "$REPO" --title "$title" --body "$body")
  [ -n "$label" ] && args+=(--label "$label")

  if [ "$AS_JSON" = "true" ]; then
    local out
    out="$(gh "${args[@]}" --json url,number 2>/dev/null)"
    [ -z "$out" ] && { echo "gh-triage feature: failed to create issue in $REPO" >&2; exit 1; }
    printf '%s\n' "$out"
  else
    local url
    url="$(gh "${args[@]}" 2>/dev/null)"
    [ -z "$url" ] && { echo "gh-triage feature: failed to create issue in $REPO" >&2; exit 1; }
    echo "gh-triage: created feature issue #${url##*/} in $REPO"
    echo "$url"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  if [ "$SUBCMD" = "feature" ]; then
    feature_create "$@"
    return 0
  fi

  require_gh
  load_config
  resolve_repo

  local issues_json repolabels
  if [ -n "$ARG_ISSUE" ]; then
    issues_json="$(gh issue view "$ARG_ISSUE" --repo "$REPO" --json number,title,labels,body,url 2>/dev/null)"
    [ -z "$issues_json" ] && { echo "gh-triage: issue #$ARG_ISSUE not found" >&2; exit 1; }
    # gh issue view returns a single object; normalize to a one-element array
    # so the shared loop below (which indexes names[i]) works unchanged.
    issues_json="$(printf '%s' "$issues_json" | jq -c 'if type=="array" then . else [.] end' 2>/dev/null)"
    [ -z "$issues_json" ] && { echo "gh-triage: failed to parse issue #$ARG_ISSUE" >&2; exit 1; }
  else
    local lim="${ARG_LIMIT:-$CFG_LIMIT}"
    [ -z "$lim" ] || [ "$lim" = "0" ] && lim=1000
    issues_json="$(gh issue list --repo "$REPO" --state open --limit "$lim" \
      --json number,title,labels,body,url 2>/dev/null)"
    [ -z "$issues_json" ] && issues_json='[]'
  fi

  if [ "$SUBCMD" = "list" ]; then
    echo "$issues_json"
    return 0
  fi

  repolabels="$(fetch_repo_labels)"

  # Count
  local total
  total="$(printf '%s' "$issues_json" | jq 'length')"
  echo "gh-triage: repo=$REPO issues=$total auto_label=$AUTO_LABEL"

  if [ "$AS_JSON" = "true" ]; then
    printf '%s' "$issues_json" | jq -c --arg bl "$LABELS_BUG" --arg fl "$LABELS_FEATURE" --arg cl "$LABELS_CHORE" '
      map(. + {
        existing_labels: [.labels[].name] | join(","),
        verdict: (if (.labels|map(.name)|index("bug")) then "bug"
                  elif (.labels|map(.name)|index("enhancement") // .labels|map(.name)|index("feature")) then "feature"
                  elif (.labels|map(.name)|index("chore")) then "chore"
                  else "unknown" end)
      })'
    return 0
  fi

  local idx num title existing plan verdict severity labels
  for idx in $(seq 0 $((total - 1))); do
    num="$(printf '%s' "$issues_json" | jq -r ".[$idx].number")"
    title="$(printf '%s' "$issues_json" | jq -r ".[$idx].title")"
    existing="$(printf '%s' "$issues_json" | jq -r '.[$idx].labels[].name' --argjson idx "$idx" 2>/dev/null | tr '\n' ' ')"
    plan="$(classify_and_plan "$num" "$title" "$(printf '%s' "$issues_json" | jq -r ".[$idx].body")" "$existing" "$repolabels")"
    verdict="$(printf '%s' "$plan" | cut -d'|' -f2)"
    severity="$(printf '%s' "$plan" | cut -d'|' -f3)"
    labels="$(printf '%s' "$plan" | cut -d'|' -f4)"
    echo "#$num  [$verdict/${severity}]  $title"
    echo "   existing: ${existing:-none}"
    if [ -n "$labels" ]; then
      echo "   -> labels: $labels"
      apply_labels "$num" "$labels"
    else
      echo "   -> no labels to add"
    fi
  done

  if [ "$DRY_RUN" = "true" ]; then
    echo "gh-triage: dry-run complete (no labels applied)."
  fi
}

main "$@"
