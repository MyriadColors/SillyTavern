#!/usr/bin/env bash

# Sync this fork with upstream SillyTavern by merging instead of rebasing.
#
# Why this exists: `git pull upstream staging` starts a rebase because `pull.rebase = true`
# is set in the global git config. That replays every local commit onto the new upstream tip
# and raises the same conflicts again for each one. This fork keeps its custom commits as
# commits and merges, so an upstream sync is a single commit with no conflict replay.
#
# Usage: ./sync-upstream.sh [branch]     (defaults to the current branch)

set -euo pipefail

cd "$(dirname "$0")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}WARNING:${NC} $*"; }
fail() { echo -e "${RED}ERROR:${NC} $*" >&2; exit 1; }

usage() {
    cat <<'USAGE'
Sync this fork with upstream SillyTavern using a merge, never a rebase.

Usage: ./sync-upstream.sh [branch]

Arguments:
  branch    Branch to sync with its upstream counterpart.
            Defaults to the currently checked out branch.

Pulls nothing on its own and pushes nothing. Review the merge commit before you push.
Roll back a sync with: git reset --hard <tag printed at the end>
USAGE
}

BRANCH=""
while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        -*) fail "Unknown option: $1. Run with --help for usage." ;;
        *) BRANCH="$1" ;;
    esac
    shift
done

command -v git > /dev/null 2>&1 || fail "Git is not installed. See https://git-scm.com/downloads"
[ -d .git ] || fail "Not running from a Git repository."

# Refuse to touch anything while git is already mid-operation. An interrupted rebase
# replaying local commits is exactly the state this script exists to avoid.
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
    fail "A rebase is already in progress. Cancel it first with: git rebase --abort"
fi
if [ -f .git/MERGE_HEAD ]; then
    fail "A merge is already in progress. Finish it with: git commit, or cancel with: git merge --abort"
fi
if [ -f .git/CHERRY_PICK_HEAD ]; then
    fail "A cherry-pick is already in progress. Finish it with: git cherry-pick --continue, or cancel with: git cherry-pick --abort"
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$CURRENT_BRANCH" != "HEAD" ] || fail "Detached HEAD. Check out a branch before syncing."
BRANCH="${BRANCH:-$CURRENT_BRANCH}"

DIRTY="$(git status --porcelain --untracked-files=no)"
if [ -n "$DIRTY" ]; then
    echo "$DIRTY" >&2
    fail "Tracked files are modified. Commit or stash them before syncing."
fi

git remote get-url upstream > /dev/null 2>&1 \
    || fail "No 'upstream' remote found. Add it with: git remote add upstream https://github.com/SillyTavern/SillyTavern.git"

# fetch + merge rather than pull, so the pull.rebase setting cannot take effect.
info "Fetching upstream/$BRANCH"
if ! git fetch --prune upstream "$BRANCH"; then
    fail "Could not fetch upstream/$BRANCH. Does that branch exist upstream?"
fi

if git merge-base --is-ancestor "upstream/$BRANCH" HEAD; then
    info "Already up to date with upstream/$BRANCH. Nothing to do."
    exit 0
fi

# Tag the current tip so a bad sync can be undone with a single reset.
BACKUP_TAG="upstream-sync-backup-$(date +%Y%m%d-%H%M%S)"
git tag "$BACKUP_TAG" HEAD
info "Rollback tag: $BACKUP_TAG"

# This fork deletes package-lock.json and ignores it because bun.lock is authoritative.
# Upstream still tracks that file, so every upstream merge can raise a modify/delete
# conflict on it. Resolve that one automatically by deleting the file again.
resolve_package_lock() {
    [ -n "$(git diff --name-only --diff-filter=U -- package-lock.json)" ] || return 1
    grep -qx '/package-lock.json' .gitignore || return 1
    git rm --force --quiet -- package-lock.json
}

info "Merging upstream/$BRANCH"
MERGE_FAILED=0
git merge --no-edit "upstream/$BRANCH" || MERGE_FAILED=1

if [ "$MERGE_FAILED" -eq 1 ]; then
    UNMERGED="$(git diff --name-only --diff-filter=U)"
    if [ "$UNMERGED" = "package-lock.json" ] && resolve_package_lock; then
        warn "Resolved package-lock.json by deleting it again (bun.lock is authoritative)."
        git commit --no-edit
    else
        [ -n "$UNMERGED" ] && echo -e "${RED}Unmerged files:${NC}" >&2 && echo "$UNMERGED" >&2
        fail "Merge needs manual resolution. Undo it with: git reset --hard $BACKUP_TAG"
    fi
fi

# Upstream may also re-add package-lock.json without conflicting, which would undo the
# fork's deletion. Keep the deletion authoritative either way.
if git ls-files --error-unmatch package-lock.json > /dev/null 2>&1 \
    && grep -qx '/package-lock.json' .gitignore; then
    warn "Upstream re-added package-lock.json. Removing it again."
    git rm --force --quiet -- package-lock.json
    git commit -m "chore: drop package-lock.json, bun.lock is the authoritative lockfile"
fi

info "Sync complete: $BRANCH"
echo
echo "Changed by this sync:"
git diff --stat "$BACKUP_TAG" HEAD
echo
if git diff --quiet "$BACKUP_TAG" HEAD -- package.json bun.lock; then
    :
else
    warn "Dependencies changed. Run your normal start script so it can install them."
    echo
fi

echo "Rollback:  git reset --hard $BACKUP_TAG"
if [ "$(git config --get pull.rebase)" = "true" ]; then
    echo
    warn "'pull.rebase = true' is set, so a plain 'git pull' will still rebase."
    echo "         Disable it with: git config --global pull.rebase false"
fi
echo "Nothing was pushed. Review the merge, then publish it with: git push origin $BRANCH"