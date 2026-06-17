# Review Lens

## Status

This document is an optional, non-authoritative reference. It is not an agent, skill, command, workflow, gate, authority artifact, or approval artifact. It is not automatically loaded. It must not override SOF routing, artifacts, approved tuples, commands, approvals, verification rules, audit rules, stop conditions, or user instructions. It is extensible through `sof-support/registry.md`. Select and read this document only when task-relevant.

## Checklist Perspective

When reviewing plans or code changes, watch for:

- **Unnecessary dependencies, package managers, or frameworks** — additions that expand the dependency surface without a clear requirement.
- **Generated scaffolding or unrequired files** — templates, configs, or boilerplate not required by the approved change.
- **Broad refactors, cleanup, formatting, or documentation rewrites** — changes outside the approved scope that restructure, reformat, or rewrite existing material.
- **Speculative abstractions, journaling, recovery, or state systems** — infrastructure for future features, undo/redo mechanisms, or state management not demanded by the approved plan.
- **Duplicate or excessive validation layers** — redundant checks that already exist in the approved pipeline or agent boundaries.
- **Privacy and publication-risk leakage** — secrets, credentials, private paths, or internal references that should not appear in public repositories or release artifacts.

This lens is non-authoritative. Agents may consult it for supplemental guidance but must not treat it as binding. The approved plan, evidence, and agent definitions take precedence.
