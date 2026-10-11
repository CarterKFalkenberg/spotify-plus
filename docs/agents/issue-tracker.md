# Issue tracker: GitHub

Use GitHub Issues in `CarterKFalkenberg/spotify-plus`. The repository is already on GitHub and the user delegated project process. Use explicit `--repo CarterKFalkenberg/spotify-plus` with `gh`, or the connected GitHub tools when available. Use private temporary body files or structured arguments for multiline content; never interpolate bodies into shell code.

The product brief, accepted decisions and plan remain the product specification. `.build/tasks.json` is the implementation milestone list. Link them from issues rather than copying conflicting versions. Specs and the Wayfinder map may live in issues, but settled product choices must not be reopened as unanswered questions.

PRs as a request surface: no. All shipped repository changes nevertheless go through PRs; these are different concerns. See `docs/agents/delivery.md` for autonomous review and merge.

## Routine operations

When a skill says "publish to the issue tracker," create a GitHub issue with a specific title and `--body-file`. When it says "fetch the ticket," read the issue body and comments (`gh issue view N --repo CarterKFalkenberg/spotify-plus --json number,title,body,labels,comments`). List open issues before creating one to avoid duplicates. Update/comment using body files; close an implementation issue only after its acceptance criteria are verified and its PR is merged. A PR merge alone does not prove live or human acceptance.

The `triage` skill is not installed, so no triage label configuration is required. Wayfinder decision tickets and implementation milestones are separate: decisions close when resolved; build milestones follow `docs/agents/acceptance.md`.

## Wayfinding operations

Create a map issue labelled `wayfinder:map` only for unresolved multi-session decisions. Create child issues labelled `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`. Create missing labels when the map needs them. Use names as links in human-facing output.

Link children using GitHub sub-issues and blocking edges using native issue dependencies. Inspect the current CLI/API before writing. If those features are unavailable, put `Part of #<map>` and `Blocked by: #<numbers>` in child bodies and keep a linked child list on the map. IDs in dependency API calls are database IDs, not displayed issue numbers.

The frontier consists of open, unassigned children whose blockers are closed; choose in map order. Claim before work with `gh issue edit N --add-assignee @me`. Resolve with a findings comment, close the issue, then add a named pointer to the map's Decisions so far. Never claim human input occurred when the user has not provided it.
