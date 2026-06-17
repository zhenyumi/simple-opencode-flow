# I/O Efficiency Lens

## Status

This document is an optional, non-authoritative reference. It is not an agent, skill, command, workflow, gate, authority artifact, or approval artifact. It is not automatically loaded. It must not override SOF routing, artifacts, approved tuples, commands, approvals, verification rules, audit rules, stop conditions, or user instructions. It is extensible through `sof-support/registry.md`. Select and read this document only when task-relevant.

## Checklist Perspective

When planning, implementing, or reviewing changes where repository I/O cost matters, watch for:

- **Broad discovery before indexing** - prefer `rg`, glob/list results, Evidence IDs, and changed-file lists before opening many files.
- **Oversized handoffs** - pass paths, section names, line anchors, compact facts, and unresolved gaps instead of large source excerpts or raw transcripts.
- **Missing access index** - plans should identify required authority sections, required repository files, optional follow-up files, prohibited scope expansion, expected changed files, verification commands, and protected paths per implementation unit.
- **Unexplained scope expansion** - agents should record why any file outside the Repository Access Index was read.
- **Unsafe I/O shortcuts** - do not remove approval tuple hashing, repository state checks, diff attribution, or required verification commands merely to save reads.

This lens is non-authoritative. Agents may consult it for supplemental guidance but must not treat it as binding. The approved plan, evidence, state receipts, and agent definitions take precedence.
