#!/bin/sh
# Daily adoption-metrics run for launchd (com.spfn.adoption-metrics, 23:00 KST):
# append today's row and commit it to main. snapshot.mjs itself skips when
# today's row already exists, so a manual run earlier the same day is safe.
#
# Install this against the main checkout, never a feature worktree. A merged
# branch's worktree keeps its own HEAD, so a runner wired to one commits every
# row to that dead branch and main never receives a single day. That happened
# once, silently, and the branch check below is what makes it loud instead.
set -eu
cd "$(dirname "$0")/../.."

branch=$(git symbolic-ref --quiet --short HEAD || echo "")
if [ "$branch" != "main" ]
then
    echo "adoption-metrics: on '${branch:-detached HEAD}', not main — point launchd at the main checkout" >&2
    exit 1
fi

node scripts/adoption-metrics/snapshot.mjs
if ! git diff --quiet -- scripts/adoption-metrics/snapshots.jsonl
then
    git add scripts/adoption-metrics/snapshots.jsonl
    git commit -m "chore(metrics): $(date +%Y-%m-%d) 채택 지표 행을 기록한다"
    git push origin HEAD || echo "push failed; row committed locally"
fi
