#!/usr/bin/env bash
# Waits for CI's verdict on the commit a release is built from, and fails
# the release unless that verdict is a pass.
#
# CI runs the whole suite on every push to main. A release used to run it
# again on its own runners, which added eighty minutes on macOS and, on a
# busy runner, a timing flake that had nothing to do with the code. The
# commit is the same one either way, so the release asks CI instead.
#
# Needs GH_TOKEN with checks: read, GITHUB_REPOSITORY and GITHUB_SHA.
set -euo pipefail

check="Typecheck, test and build"
tries=180 # every 30 seconds, so an hour and a half
repo="${GITHUB_REPOSITORY:?}"
sha="${GITHUB_SHA:?}"

for i in $(seq 1 "$tries"); do
  # Every run of the check on this commit: a rerun adds one rather than
  # replacing the first, so one pass among them is enough.
  runs=$(gh api "repos/$repo/commits/$sha/check-runs?per_page=100" \
    --jq "[.check_runs[] | select(.name == \"$check\")]")
  passed=$(jq '[.[] | select(.conclusion == "success")] | length' <<<"$runs")
  pending=$(jq '[.[] | select(.status != "completed")] | length' <<<"$runs")
  total=$(jq 'length' <<<"$runs")

  if [ "$passed" -gt 0 ]; then
    echo "CI passed on $sha."
    exit 0
  fi
  if [ "$total" -gt 0 ] && [ "$pending" -eq 0 ]; then
    echo "::error::CI did not pass on $sha: $(jq -r 'map(.conclusion) | join(", ")' <<<"$runs"). Fix or rerun it, then rerun this job."
    exit 1
  fi
  echo "Waiting for CI on $sha ($i/$tries)"
  sleep 30
done

echo "::error::CI never finished on $sha. Is this commit on main?"
exit 1
