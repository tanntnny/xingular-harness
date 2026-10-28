---
id: ADR-0048
title: A skill named anywhere in a message is required for that request
status: Accepted
created: 2026-11-20
---

# ADR-0048: A skill named anywhere in a message is required for that request

## Decision

- `$name` is a skill invocation at any word start in a message, not only as its first token. The
  composer's palette opens at the caret and replaces only the token being typed; the rest of the
  draft and its caret stay in place.
- Every `$name` that names a skill the session can load makes that skill required for the request.
  The named skills travel as `Launch.requiredSkills`, and the prompt compiler renders them as the
  dynamic `required-skills` section: the skill's text from the pinned variant, the directive to
  follow it, and an honest line for a name the variant does not have. The shipped
  `plugin-authoring` skill fills in when the variant has none.
- The section belongs to the request. `sessionLaunch` resends it like `references`, even when it is
  identical to the previous snapshot.
- The terminal builds the same text with `requiredSkillsText` from Pi's loaded skills and appends it
  as a hidden `xingular-required-skills` custom message. It no longer rewrites a leading `$name` to
  `/skill:name`; the person's message reaches the model unchanged and the requirement is enforced at
  every position.
- A required skill changes no tool and no permission: the run's callable set and the gate are
  untouched. It is a prompt-level requirement, not a capability narrowing.

## Rationale

Pi expands only a leading `/skill:name`, so a mid-message skill was plain text and had no effect.
Moving the requirement into the request-scoped prompt text makes the same promise at every position,
keeps the stable prefix (and therefore the provider cache) intact, and gives the terminal and a host
one shared wording through `requiredSkillsText`.

## Consequences

A leading `$name` no longer depends on Pi's `/skill:name` expansion. The skill's text is delivered
once per request that names it, so repeating the same skill in several turns repeats its text in
native history; the model sees the most recent copy. The App's composer already inserts `$` chips
anywhere; its reference path now sends skills as `requiredSkills` rather than as pinned notes.
Skills that a variant does not contain are reported as unavailable rather than silently dropped.
