# SOF Support Document Registry

## Status

Support documents are optional, non-authoritative references. Flow reads this registry's fenced YAML metadata once per top-level request; support-document bodies are not automatically loaded and are read only when task-relevant. Support documents are not agents, skills, commands, workflows, gates, authority artifacts, or approval artifacts and must not override SOF routing, artifacts, approved tuples, commands, approvals, verification rules, audit rules, stop conditions, or user instructions.

## Registered Documents

### Lenses

```yaml
version: 1
documents:
  - path: lenses/io-efficiency-lens.md
    type: lens
    purpose: Checklist perspective for reducing unnecessary repository reads and oversized handoffs
    routes: [CHANGE]
    authority: non-authoritative
    auto_load: false

  - path: lenses/review-lens.md
    type: lens
    purpose: Checklist perspective for plan and code reviewers
    routes: [CHANGE]
    authority: non-authoritative
    auto_load: false
```

### Consultation Rules

Flow selects exactly one registry: the current workspace's `.opencode/sof-support/registry.md` when present, otherwise the configured global registry. A project registry fully shadows global support; registries are never merged and a broken selected registry never falls back to the other root. Flow reads only this fenced YAML metadata, validates matching entries beneath the selected support root, and never reads referenced document bodies.

Flow supplies exact candidate paths to `sof-explore-repository`, which may read task-relevant candidates and register documents actually consulted in evidence. Other agents read only exact Flow-handoff or evidence-registered paths. Permission to read a support root does not authorize registry discovery, root search, globbing, traversal, or independent consultation. Entries may add `stages`, `agents`, or `use_when` selectors without changing the validity of existing route-only entries. Agent definitions remain the runtime authority for selection and failure behavior.
