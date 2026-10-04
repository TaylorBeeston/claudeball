#!/usr/bin/env bash
# Swap the claudeball repository to the slim (rewritten, option A) history: docs/repo-size.md section 5.
#
#   tools/repo-diet/swap-to-slim.sh              DRY RUN (default): runs the read-only checks, prints every command that would change something
#   tools/repo-diet/swap-to-slim.sh --execute    does it (asks once more before the force-push)
#   options: --repair-old-worktrees   afterwards, point the old thread worktrees at the moved old repository (read-only use; see "herdr" below)
#
# What it does, in order:
#   1. checks: the real repo is clean, on main, at the commit the slim repo was rewritten from; origin/main is the commit we expect to replace;
#      the backup bundle exists, verifies and contains that main; the slim repo passes git fsck and the size check; the intermediates release exists
#   2. pushes the slim history to GitHub main ONLY: git push --force-with-lease=main:<old origin sha> origin main (other remote refs are untouched)
#   3. moves the old local repo to $OLD, clones the slim repo to $REAL (origin = GitHub), carries over the local, untracked state
#      (.herdr-project/, public/hdri/, the MPFB photos, the build intermediates now git-ignored), npm ci, installs the size pre-commit hook
#   4. post-checks: the deploy run for the new main, the live site, a shipped asset
# Nothing is deleted: the old repository (with every branch and worktree registration) stays in $OLD, the bundle in $BUNDLE.
set -euo pipefail

REAL=${REAL:-$HOME/dev/test/ai/claudeball}
OLD=${OLD:-$HOME/dev/test/ai/claudeball-pre-diet}
SLIM=${SLIM:-$HOME/claudeball-slim-final/repo}
BUNDLE=${BUNDLE:-$HOME/claudeball-backup.bundle}
REMOTE=${REMOTE:-git@github.com:TaylorBeeston/claudeball.git}
GHREPO=${GHREPO:-TaylorBeeston/claudeball}
SITE=${SITE:-https://taylorbeeston.github.io/claudeball/}
SOURCE_SHA=${SOURCE_SHA:-$(cat "$SLIM/../SOURCE_SHA" 2>/dev/null || true)}     # the local main the slim repo was rewritten from
EXPECT_REMOTE=${EXPECT_REMOTE:-$(cat "$SLIM/../REMOTE_SHA" 2>/dev/null || true)} # origin/main at rewrite time (the lease)

EXECUTE=0; REPAIR=0
for a in "$@"; do case "$a" in --execute) EXECUTE=1 ;; --repair-old-worktrees) REPAIR=1 ;; *) echo "unknown option $a"; exit 2 ;; esac; done
say() { printf '\n== %s\n' "$*"; }
ok() { printf '   ok   %s\n' "$*"; }
fail() { printf '   FAIL %s\n' "$*"; exit 1; }
run() { printf '   $ %s\n' "$*"; if [ "$EXECUTE" = 1 ]; then eval "$@"; fi; }
[ "$EXECUTE" = 1 ] && echo "MODE: EXECUTE" || echo "MODE: DRY RUN (nothing is changed; pass --execute to do it)"

say "1. checks (read-only)"
[ -n "$SOURCE_SHA" ] && [ -n "$EXPECT_REMOTE" ] || fail "SOURCE_SHA / REMOTE_SHA unknown (files next to the slim repo, or set the env vars)"
[ -d "$REAL/.git" ] || fail "$REAL is not a git repository"
[ -e "$OLD" ] && fail "$OLD already exists"
[ -z "$(git -C "$REAL" status --porcelain)" ] && ok "real repo clean" || fail "real repo has uncommitted changes"
[ "$(git -C "$REAL" rev-parse --abbrev-ref HEAD)" = main ] && ok "real repo on main" || fail "real repo not on main"
[ "$(git -C "$REAL" rev-parse main)" = "$SOURCE_SHA" ] && ok "local main = $SOURCE_SHA (the rewrite source)" || fail "local main moved since the rewrite ($(git -C "$REAL" rev-parse --short main) != ${SOURCE_SHA:0:7}): re-run the rewrite (docs/repo-size.md 5.A) on the new tip"
for b in $(git -C "$REAL" for-each-ref --format='%(refname:short)' refs/heads); do
  n=$(git -C "$REAL" rev-list --count "main..$b"); [ "$n" = 0 ] && continue
  # not in main, but superseded when every file it changes is byte-identical in the slim repo (e.g. the repo-diet tools themselves)
  for f in $(git -C "$REAL" diff --name-only "main...$b"); do
    a=$(git -C "$REAL" rev-parse -q --verify "$b:$f" || echo none); z=$(git -C "$SLIM" rev-parse -q --verify "HEAD:$f" || echo none)
    [ "$a" = "$z" ] || fail "branch $b has $n commit(s) not in main, and $f differs from the slim repo: merge or save it first"
  done
  echo "   ok   branch $b: $n commit(s) not in main, all of its changes are already in the slim repo"
done; ok "every local branch is merged into main or superseded by the slim repo"
REMOTE_MAIN=$(git ls-remote "$REMOTE" refs/heads/main | cut -f1)
[ "$REMOTE_MAIN" = "$EXPECT_REMOTE" ] && ok "origin/main = $REMOTE_MAIN (the lease)" || fail "origin/main is $REMOTE_MAIN, expected $EXPECT_REMOTE: someone pushed; stop and re-check"
OTHER=$(git ls-remote --heads "$REMOTE" | grep -v 'refs/heads/main$' | cut -f2 || true)
[ -z "$OTHER" ] && ok "no other remote branches" || echo "   note the remote has other branches, untouched by this push (they keep the OLD history alive on GitHub): $OTHER"
[ -f "$BUNDLE" ] || fail "backup bundle missing: git -C $REAL bundle create $BUNDLE --all"
git -C "$REAL" bundle verify -q "$BUNDLE" >/dev/null 2>&1 && ok "bundle verifies ($(du -h "$BUNDLE" | cut -f1))" || fail "bundle does not verify"
git bundle list-heads "$BUNDLE" | grep -q "^$SOURCE_SHA refs/heads/main" && ok "bundle contains main $SOURCE_SHA" || fail "bundle does not contain main $SOURCE_SHA: re-create it"
git -C "$SLIM" fsck --full --strict >/dev/null 2>&1 && ok "slim repo fsck clean" || fail "slim repo fsck"
(cd "$SLIM" && node tools/repo-diet/check-size.mjs >/dev/null) && ok "slim repo size check ($(git -C "$SLIM" count-objects -vH | sed -n 's/size-pack: //p') pack)" || fail "slim repo size check"
[ -z "$(git -C "$SLIM" status --porcelain)" ] && ok "slim repo clean" || fail "slim repo has uncommitted changes"
if gh release view assets-v1 --repo "$GHREPO" >/dev/null 2>&1; then ok "release assets-v1 exists"; else echo "   note release assets-v1 does not exist yet: npm run assets:fetch will 404 until it is created (the deploy does not need it)"; fi

say "2. push the slim history to GitHub main (only main; the lease refuses if origin/main moved)"
run "git -C '$SLIM' remote get-url origin >/dev/null 2>&1 || git -C '$SLIM' remote add origin '$REMOTE'"
if [ "$EXECUTE" = 1 ]; then read -r -p "   force-push the rewritten main to $REMOTE now? type yes: " yn; [ "$yn" = yes ] || fail "aborted before the push"; fi
run "git -C '$SLIM' push --force-with-lease=main:$EXPECT_REMOTE origin main"

say "3. swap the local checkout"
run "mv '$REAL' '$OLD'"
run "git clone --no-local '$SLIM' '$REAL'"
run "git -C '$REAL' remote set-url origin '$REMOTE' && git -C '$REAL' fetch -q origin && git -C '$REAL' branch -u origin/main main"
run "[ \"\$(git -C '$REAL' rev-parse main)\" = \"\$(git -C '$REAL' rev-parse origin/main)\" ]"
# untracked local state of the old checkout: herdr project files, sky HDRIs, perf shots, the MPFB photos, and the intermediates (git-ignored now)
run "cd '$OLD' && { git ls-files --others --ignored --exclude-standard | grep -v -e '^node_modules/' -e '^dist/' -e '__pycache__' ; git ls-files | grep -E -f <(sed -n 's/^regex://p' tools/repo-diet/intermediates.txt; grep -v -e '^#' -e '^regex:' -e '^\$' tools/repo-diet/intermediates.txt | sed 's/^/^/'); } | rsync -a --files-from=- '$OLD/' '$REAL/'"
run "cp '$OLD/.git/info/exclude' '$REAL/.git/info/exclude'"   # local ignores (e.g. .herdr-project/) live there, not in .gitignore
run "mkdir -p '$REAL/.claude' '$REAL/.cache-tmp'"
run "cd '$REAL' && git status --short | head -5"   # must print nothing: everything carried over is ignored
run "cd '$REAL' && npm ci --no-audit --no-fund && git config core.hooksPath tools/repo-diet/hooks"

say "4. herdr: the old thread worktrees"
echo "   The thread worktrees under ~/.herdr/worktrees/claudeball/ point at $REAL/.git/worktrees/<name>, which the new clone does not have:"
WT=$REAL; [ -d "$OLD/.git" ] && WT=$OLD
git -C "$WT" worktree list 2>/dev/null | sed 1d | sed 's/^/     /' || true
echo "   They have no unmerged work (checked above). Recover by re-creating each needed thread from the new main (herdr / the coordinator);"
echo "   the old ones are kept registered in $OLD."
if [ "$REPAIR" = 1 ]; then run "git -C '$OLD' worktree repair"; else echo "   (optional, read-only use of the old worktrees: git -C '$OLD' worktree repair, or pass --repair-old-worktrees)"; fi

say "5. post-checks"
run "sleep 20; gh run list --repo '$GHREPO' --workflow deploy.yml --branch main -L 1"
run "gh run watch --repo '$GHREPO' \$(gh run list --repo '$GHREPO' --workflow deploy.yml --branch main -L 1 --json databaseId -q '.[0].databaseId') --exit-status"
run "curl -s -o /dev/null -w 'site %{http_code}\n' '$SITE'"
run "curl -s -o /dev/null -w 'player_base.glb %{http_code}\n' '${SITE}assets/optimized/players/player_base.glb'"
echo
echo "Follow-ups (decide separately; not done by this script):"
echo "  - remote branch imgbot / PR #1 keep the old history on GitHub: gh pr close 1 --repo $GHREPO --delete-branch (and pause the ImgBot app, or it reopens)"
echo "  - GitHub frees the space after its own GC; refs/pull/* keep old objects: ask GitHub Support to run a GC / drop cached refs"
echo "  - the intermediates release: gh release create assets-v1 ~/claudeball-assets/claudeball-intermediates-assets-v1.tar.gz --repo $GHREPO ..."
[ "$EXECUTE" = 1 ] && echo "DONE" || echo "DRY RUN finished: nothing was changed"
