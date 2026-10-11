# Domain documentation

This is a single-context repository. Use a root `GLOSSARY.md` for domain vocabulary and `docs/adr/` for consequential architecture decisions, creating entries only when there is an actual term or decision to record. Read relevant existing entries before changing behavior; proceed when they do not yet exist.

The original product brief plus `docs/DECISIONS.md` are authoritative product intent; `docs/PLAN.md` describes implementation. Link existing decisions rather than duplicating them across an ADR, issue and plan. A glossary defines terms, not implementation instructions.

Use the domain-modeling skill when resolving or changing terminology. Do not conduct another interview about already accepted product defaults.

Before exploring an area, read the glossary and any ADRs relevant to it. If a root `GLOSSARY-MAP.md` is introduced later, follow its context pointers instead. Missing glossary/ADR files are expected during setup: proceed silently rather than creating empty scaffolding.

Use the glossary's canonical terms in code, tests, issues and explanations. Flag a proposal that contradicts an existing ADR explicitly, with the reason to revisit it; never silently override an accepted decision. Follow the installed domain-modeling skill's glossary and ADR formats when creating entries.
