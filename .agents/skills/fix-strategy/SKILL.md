---
name: fix-strategy
description: Choose the right scope and ownership boundary for bug fixes, regressions, brittle code, and workflow failures. Use when Codex should prefer a durable architectural fix over a narrow patch while still keeping scope pragmatic.
---

# Fix Strategy

Default to the smallest change in the right long-term place, not the smallest diff.

## Workflow

1. Confirm the real failure mode, affected boundary, and likely recurrence path before editing.
2. Prefer the fix at the ownership layer that can prevent the class of issue from repeating.
3. Avoid smallest-possible patch bias unless the user explicitly asks for a localized or temporary fix.
4. Improve clarity of boundaries, validation, defaults, or call flow when that materially reduces future breakage.
5. Keep scope pragmatic:
   - fix the root cause
   - include nearby hardening only when it directly reduces recurrence
   - avoid opportunistic rewrites unrelated to the failure
6. Call out any residual risk when the correct long-term fix is too large for the requested scope.

## Guardrails

- Do not expand into a broad refactor without a concrete recurrence or ownership reason.
- Do not preserve a brittle design just because it is already in place.
- Do not hide a temporary mitigation as if it were a full fix.
