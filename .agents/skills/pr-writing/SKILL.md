---
name: pr-writing
description: Write or update a pull request title and description from the final diff and actual verification evidence. Use when preparing, opening, or refreshing a PR; scale detail to the change and follow the repository template.
---

# Write a reviewable pull request

Read the actual diff against the intended base, the originating request/spec, repository PR conventions, and verification results. Do not infer implemented behavior from the plan or commit messages alone.

Lead with the concrete problem and the resulting behavior. Use a short before/after example when it explains the change better than listing files. Describe the final implementation for a reviewer who has not seen the conversation. If scope changed, rewrite the title and body around the final diff.

Include only what helps assess the change:

- A specific title naming the behavior or defect, rather than "updates" or "improvements."
- Why the change is needed and what a user or operator will observe.
- The architectural choice or tradeoff only when it materially affects review.
- Verification actually performed, with its outcome and practical limits. Distinguish mocked tests, live integration checks and human acceptance. Never claim an unrun test passed.
- Migration, rollout or recovery details only when the change needs them.

A small PR usually needs one or two explanatory paragraphs and a short verification list. Use headings only when the repository template or complexity benefits. Omit a file inventory, development diary, canned summary, decorative checklists and abandoned approaches unless they explain a surviving tradeoff.

For this Spotify project, never include tokens, account identifiers, song/artist names from the real library, or real-data screenshots. Link the relevant specification or issue; close an issue only if its acceptance criteria are met. Human phone acceptance may remain pending after software PRs merge, and must be labelled that way.

Before publishing, check that every behavioral claim is supported by the diff and every verification claim by evidence. Read the rendered title/body once as a reviewer. When updating an existing PR, preserve useful review discussion and update the description rather than appending contradictory history.

Use structured tool arguments or `gh pr create/edit --body-file` with actual newlines. Creation/update/merge authority comes from the user's request and repository workflow; this writing skill grants no additional authority. After creating a PR, attach it to the chat when the Codex app tool is available.
