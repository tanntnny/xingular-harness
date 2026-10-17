# Personal Codex live check — 2026-10-17

The user authorized their personal Codex account for the final live check. The production
Harness CLI ran in an 80×24 PTY, with a disposable working directory, data root and account.
Only an unexpired access token was copied into the owner-only disposable secret store;
the original refresh token was never copied or used. No process launched against the source
Codex profile. A single user prompt requested one native `read` of an isolated fixture followed
by a short marker response.

Codex returned **“The usage limit has been reached”** before any tool execution or successful
assistant response. Harness surfaced that error and recorded the run as failed. This attempt
does not satisfy successful live streaming/tool acceptance. The JSON report records
`passed: false` and `outcome: blocked_by_provider_usage_limit` for that reason.

The exit code was zero after orderly application shutdown. The PTY supervisor independently
confirmed terminal attributes were restored; cursor visibility and bracketed-paste shutdown
were checked in the raw ANSI stream. The source authentication file's before/after SHA-256
comparison matched. The disposable profile, including its copied access credential, was
deleted. Credentials and personal account identity are absent from the retained evidence.

[verification.json](verification.json) binds the production CLI digest and the cumulative
[compressed ANSI capture](complete-80x24.ansi.gz). Replay at 80×24. The capture records the
quota failure and normal shutdown, not a successful model reply. The existing controlled
transport tests separately cover streaming, tools and approvals.
