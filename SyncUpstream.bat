@echo off
@setlocal enabledelayedexpansion
pushd %~dp0

REM Sync this fork with upstream SillyTavern by merging instead of rebasing.
REM See sync-upstream.sh for the full explanation of why.

if /i "%~1"=="-h" goto usage
if /i "%~1"=="--help" goto usage

echo Checking Git installation
git --version > nul 2>&1
if errorlevel 1 (
    echo ERROR: Git is not installed on this system.
    echo Install it from https://git-scm.com/downloads
    goto end
)

if not exist .git (
    echo ERROR: Not running from a Git repository.
    goto end
)

REM Refuse to touch anything while git is already mid-operation. An interrupted rebase
REM replaying local commits is exactly the state this script exists to avoid.
if exist .git\rebase-merge goto rebase_in_progress
if exist .git\rebase-apply goto rebase_in_progress
if exist .git\MERGE_HEAD goto merge_in_progress
if exist .git\CHERRY_PICK_HEAD goto cherry_pick_in_progress

FOR /F "tokens=*" %%i IN ('git rev-parse --abbrev-ref HEAD') DO SET CURRENT_BRANCH=%%i
if "!CURRENT_BRANCH!"=="HEAD" (
    echo ERROR: Detached HEAD. Check out a branch before syncing.
    goto end
)

SET TARGET_BRANCH=%~1
if "!TARGET_BRANCH!"=="" SET TARGET_BRANCH=!CURRENT_BRANCH!

SET DIRTY=
FOR /F "tokens=*" %%i IN ('git status --porcelain --untracked-files=no') DO SET DIRTY=1
if defined DIRTY (
    git status --short --untracked-files=no
    echo ERROR: Tracked files are modified. Commit or stash them before syncing.
    goto end
)

git remote get-url upstream > nul 2>&1
if errorlevel 1 (
    echo ERROR: No 'upstream' remote found.
    echo Add it with: git remote add upstream https://github.com/SillyTavern/SillyTavern.git
    goto end
)

REM fetch + merge rather than pull, so the pull.rebase setting cannot take effect.
echo ==^> Fetching upstream/!TARGET_BRANCH!
git fetch --prune upstream !TARGET_BRANCH!
if errorlevel 1 (
    echo ERROR: Could not fetch upstream/!TARGET_BRANCH!. Does that branch exist upstream?
    goto end
)

git merge-base --is-ancestor upstream/!TARGET_BRANCH! HEAD
if not errorlevel 1 (
    echo Already up to date with upstream/!TARGET_BRANCH!. Nothing to do.
    goto end
)

REM Tag the current tip so a bad sync can be undone with a single reset.
SET BACKUP_TAG=upstream-sync-backup-%RANDOM%%RANDOM%
git tag !BACKUP_TAG! HEAD
if errorlevel 1 (
    echo ERROR: Could not create the rollback tag.
    goto end
)
echo Rollback tag: !BACKUP_TAG!

echo ==^> Merging upstream/!TARGET_BRANCH!
git merge --no-edit upstream/!TARGET_BRANCH!
if errorlevel 1 goto handle_conflict

REM This fork deletes package-lock.json and ignores it because bun.lock is authoritative.
REM Upstream still tracks that file, so every upstream merge can raise a modify/delete
REM conflict on it. Resolve that one automatically by deleting the file again.
:handle_conflict
SET UNMERGED_COUNT=0
SET UNMERGED=
FOR /F "tokens=*" %%i IN ('git diff --name-only --diff-filter=U') DO (
    SET /a UNMERGED_COUNT+=1
    SET UNMERGED=%%i
)

SET IGNORE_OK=0
findstr /x /c:"/package-lock.json" .gitignore > nul && SET IGNORE_OK=1

if "!UNMERGED_COUNT!"=="1" if "!UNMERGED!"=="package-lock.json" if "!IGNORE_OK!"=="1" goto resolve_lock
if !UNMERGED_COUNT! gtr 0 echo Unmerged files: !UNMERGED!
goto merge_failed

:resolve_lock
echo WARNING: Resolved package-lock.json by deleting it again (bun.lock is authoritative).
git rm --force --quiet -- package-lock.json
if errorlevel 1 goto merge_failed
git commit --no-edit
if errorlevel 1 goto merge_failed

REM Upstream may also re-add package-lock.json without conflicting, which would undo the
REM fork's deletion. Keep the deletion authoritative either way.
git ls-files --error-unmatch package-lock.json > nul 2>&1
if not errorlevel 1 if "!IGNORE_OK!"=="1" (
    echo WARNING: Upstream re-added package-lock.json. Removing it again.
    git rm --force --quiet -- package-lock.json
    git commit -m "chore: drop package-lock.json, bun.lock is the authoritative lockfile"
)

:report
echo.
echo ==^> Sync complete: !TARGET_BRANCH!
echo.
echo Changed by this sync:
git diff --stat !BACKUP_TAG! HEAD
echo.

git diff --quiet !BACKUP_TAG! HEAD -- package.json bun.lock
if errorlevel 1 echo WARNING: Dependencies changed. Run your normal start script so it can install them.

echo.
echo Rollback:  git reset --hard !BACKUP_TAG!

SET PULL_REBASE=
FOR /F "tokens=*" %%i IN ('git config --get pull.rebase') DO SET PULL_REBASE=%%i
if "!PULL_REBASE!"=="true" (
    echo WARNING: 'pull.rebase = true' is set, so a plain 'git pull' will still rebase.
    echo          Disable it with: git config --global pull.rebase false
)

echo Nothing was pushed. Review the merge, then publish it with: git push origin !TARGET_BRANCH!
goto end

:merge_failed
echo ERROR: Merge needs manual resolution. Undo it with: git reset --hard !BACKUP_TAG!
goto end

:rebase_in_progress
echo ERROR: A rebase is already in progress. Cancel it first with: git rebase --abort
goto end

:merge_in_progress
echo ERROR: A merge is already in progress. Finish it with: git commit, or cancel with: git merge --abort
goto end

:cherry_pick_in_progress
echo ERROR: A cherry-pick is already in progress. Finish it with: git cherry-pick --continue, or cancel with: git cherry-pick --abort
goto end

:usage
echo Sync this fork with upstream SillyTavern using a merge, never a rebase.
echo.
echo Usage: SyncUpstream.bat [branch]
echo.
echo   branch    Branch to sync with its upstream counterpart.
echo             Defaults to the currently checked out branch.
echo.
echo Pushes nothing. Review the merge commit before you push.
goto end

:end
popd
endlocal