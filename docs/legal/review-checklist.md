# Operator checklist — version 1.0

Documents updated 9 November 2026 for the arrangements confirmed by the team.
Operator: Tomasz Szymański, tszymans@student.42warsaw.pl.
Local computer only; no public website. Optional AI provider: Google Gemini.

## Confirmed document decisions
- [x] Operator and monitored request address supplied by user.
- [x] Local-only development/evaluation scope.
- [x] Personal project records deleted within 30 days after final evaluation.
- [x] Seven-day logs and rolling seven-day backups, if used.
- [x] Manual access/correction/deletion requests.
- [x] Browser-memory AI conversation history; no deliberate database/log storage.
- [x] Version/effective date and synchronized Markdown/rendered content.

## Operational work still required
- [ ] Record the final evaluation date and schedule cleanup within 30 days. Include every database volume, export and project copy, not just the active Compose project.
- [ ] Configure time-based log cleanup; Docker size rotation alone does not enforce a seven-day age limit. Review nginx, app logs and terminal captures.
- [ ] Review LLM error logging: provider response text can appear in error logs. Redact content before using real participant conversations; the policy is not proof that logging already meets it.
- [ ] Inventory backups/exports, restrict access, expire them after seven days and remove all remaining copies during final cleanup.
- [ ] Monitor the contact mailbox. Verify requests using proportionate information, never passwords. Aim to acknowledge within a few days and answer normally within one month.
- [ ] Prepare and test manual deletion using disposable accounts. Inspect sessions, API keys, friendships, tournament links, games and identifying text; foreign-key cascades/nulls alone do not establish anonymity.
- [ ] Keep a minimal restricted record of completed deletions while backups can restore those accounts. Reapply deletions before using a restored backup, and remove that record when no longer needed.
- [ ] Verify actual Gemini service (Developer API / Vertex AI), account/region, recipients and transfer arrangements. AI remains disabled until verified. Do not infer provider retention, training rules or locations solely from the word “Gemini”.
- [ ] Review the drafted service/legal bases and proportional security processing against actual operations. Do not claim independent legal certification.
- [ ] Verify public legal URLs without login, footer/registration links, mobile layout and keyboard access. Resolve existing unrelated frontend build errors before release.

These documents establish the agreed policy. This change adds no retention scheduler, account deletion endpoint, consent database or provider-side erasure mechanism. Subject review and operational/privacy compliance are separate assessments.

References checked:
- https://www.dataprotection.ie/en/individuals/know-your-rights/right-be-informed-transparency-article-13-14-gdpr
- https://ai.google.dev/gemini-api/terms
- https://ai.google.dev/gemini-api/docs/usage-policies

Provider terms depend on service and configuration; no unconditional 55-day claim is made for unspecified Gemini products.
