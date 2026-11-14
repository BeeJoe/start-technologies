#!/bin/bash
set -euo pipefail

directory=${UPDATE_DIRECTORY:?Set UPDATE_DIRECTORY to the verified update artifact directory}
report="$directory/report.json"
candidate=$(jq -er '.candidate' "$report")
base=$(git rev-parse HEAD)
branch="automation/nut-$(printf '%s' "$candidate" | sha256sum | cut -c 1-16)"

# Each source revision has one PR. Never rewrite a branch a maintainer may
# have edited; a newer source revision gets its own proposal.
existing=$(gh pr list --repo "$GITHUB_REPOSITORY" --state all --head "$branch" --json url --jq '.[0].url // empty')
if [ -n "$existing" ]; then
    printf 'NUT %s already proposed: %s\n' "$candidate" "$existing"
    exit 0
fi

git apply "$directory/update.patch"
mapfile -t files < <(jq -r '.files[]' "$report")
git add -- "${files[@]}"
# This API creates a GitHub-signed commit, using the existing shared helper.
# Neither the base branch nor repository rulesets are bypassed.
remote=$(git ls-remote origin "refs/heads/$branch")
if [ -z "$remote" ]; then
    gh api "repos/$GITHUB_REPOSITORY/git/refs" -f "ref=refs/heads/$branch" -f "sha=$base" >/dev/null
    remote_head=$base
else
    git fetch --no-tags origin "refs/heads/$branch"
    remote_head=$(git rev-parse FETCH_HEAD)
fi
if [ "$remote_head" = "$base" ]; then
    printf 'chore(start-os): update NUT to %s\n' "$candidate" > "$directory/commit-message.txt"
    node scripts/commit-staged.mjs "$directory/commit-message.txt" "$branch" "$base"
else
    # Resume if an earlier run committed successfully but failed to open its PR.
    while IFS= read -r path; do
        allowed=false
        for file in "${files[@]}"; do if [ "$path" = "$file" ]; then allowed=true; fi; done
        if [ "$allowed" != true ]; then
            echo "::error::Existing $branch carries changes outside the verified update; leaving it for manual review."
            exit 1
        fi
    done < <(git diff --name-only "$base" FETCH_HEAD)
    if ! git diff --quiet FETCH_HEAD -- "${files[@]}"; then
        echo "::error::Existing $branch has different content; leaving it for manual review."
        exit 1
    fi
fi

draft=()
if [ "$(cat "$directory/release-aligned")" != true ]; then draft=(--draft); fi
python3 - "$directory" <<'PY'
import json, os, sys
from pathlib import Path
p = Path(sys.argv[1])
r = json.loads((p / 'report.json').read_text())
run = f"{os.environ['GITHUB_SERVER_URL']}/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
text = f'''## Summary

Update the pinned NUT source from `{r['current']}` to `{r['candidate']}`.

```text
verified source → pinned Trixie rebuild → normal StartOS update
```

[Upstream release notes]({r['releaseUrl']}).

## Evidence

- **Before:** `{r['current']}` was the selected Debian source.
  **After:** `{r['candidate']}` is verified against the pinned maintainer's signature,
  signed archive checksums and the upstream release digest.
- [Completed validation]({run}): source-updater regressions, all three architecture
  builds, fresh/upgrade installation, cross-version reads and shutdown-marker tests.

## Merge Danger

**Door:** two-way

The prior complete StartOS rootfs provides rollback.

**Blast Radius:** UPS

Changes host UPS drivers, server, clients and libraries together. Devices receive
the change through a StartOS release; this workflow does not deploy it.
'''
if (p / 'release-aligned').read_text().strip() != 'true':
    text += '''
This PR is a draft because the new fragment requires StartOS release-version
alignment. Follow `shared-libs/crates/start-core/VERSION_BUMP.md` before marking
it ready; this automation does not invent a migration node or release version.

```text
''' + (p / 'release-check.txt').read_text() + '\n```\n'
(p / 'pr-body.md').write_text(text)
PY

gh pr create --repo "$GITHUB_REPOSITORY" --base master --head "$branch" \
    --title "chore(start-os): update NUT to $candidate" \
    --label StartOS --label repo --label patch "${draft[@]}" \
    --body-file "$directory/pr-body.md"
