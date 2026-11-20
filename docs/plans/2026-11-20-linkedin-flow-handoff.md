# Plan: LinkedIn sequence timing, invite withdrawal and email hand-off

- Track: Sales Automation, lender outbound (vault `Sales-Automation`)
- Status: approved (Part 1 in progress)
- Approved by VJ: 2026-11-20 ("approved for now", with Unipile kept)
- Branch: `feat/lender-flow` in BigBoost-Dev/AgentSDR (each part later cherry-picked onto `upstream/main` as its own PR to Kandid-ai/AgentSDR)   PR: -

## Goal
Make a LinkedIn campaign run BigBoost's lender flow, with every new setting defaulting to today's behaviour:
- After an accept: 5 messages at +1, +4, +8, +12 and +19 days (today: 4 messages at +0, +1, +3, +6, fixed).
- Invite not accepted after N working days: withdraw it and enroll the person in email campaign A (emails 1 to 10).
- Accepted, no reply after the last message: enroll the person in email campaign B (emails 4, 6, 7, 8, "we connected on LinkedIn").
- A reply on any channel still stops everything (already true, proven 19 Nov). A hand-off never enrolls someone who replied, is Do Not Contact, or is active in another email campaign.

## Per-campaign settings (table "Campaign")
| Column | Default (= today) | Ours |
|---|---|---|
| acceptanceDelayDays (0..30) | 0 | 1 |
| followUp1DelayDays..followUp3DelayDays (1..60) | 1 / 2 / 3 | 3 / 4 / 4 |
| followUp4DelayDays (1..60) + followUp4Message | 4 / null (off) | 7 / message 5 |
| withdrawAfterWorkingDays (null or 1..60) | null = never | 4 |
| emailCampaignIfNotAcceptedId (uuid, ON DELETE SET NULL) | null | campaign A |
| emailCampaignAfterSequenceId (uuid, ON DELETE SET NULL) | null | campaign B |

Each delay counts from the previous step, as today.

## Files that change
Part 1, timing and follow-up 4:
- `scripts/add-linkedin-sequence-timing.ts` (new migration, 3 phases: enum value `FOLLOW_UP_4` on "MessageType"; Campaign and Lead columns with a CHECK; rebuild `Message_automated_lead_type_uq` CONCURRENTLY to include FOLLOW_UP_4)
- `src/lib/linkedin/schema.ts` (enum, columns, index predicate)
- `src/functions/sendFollowUps.ts` (4th stage; per-campaign delay in SQL instead of the 24/48/72h constants)
- `src/lib/linkedin/acceptanceMessage.ts`, `src/app/api/webhooks/connection-accepted/route.ts` (acceptance delay: set CONNECTED, send later)
- `src/app/api/webhooks/message-received/route.ts` (add CONNECTED to `REPLY_STATUSES`, see Deviations)
- `src/lib/linkedin/campaignSequence.ts`, `leadMessages.ts`, `migrationParity.ts`, `campaignLeads.ts`, `importLeads.ts`, `src/lib/leads/campaignAssignments.ts`, `gridCampaigns.ts`
- LinkedIn campaign API routes (create, update, get, preview), analytics route, `src/lib/analytics/overview.server.ts`, `src/lib/crm/queries.ts`
- UI: `LinkedInSequenceEditor.tsx` ("Send after [n] days" per step, a card for follow-up 4), `LinkedInCampaignWizard.tsx` review line, `LeadDetailPanel.tsx`, `MessagesLayout.tsx`, `campaigns/metrics.ts`, `CampaignOverview.tsx`
- `db/schema.sql` (dump), `docs/linkedin/campaigns.mdx`, `CHANGELOG.md`, demo seed

Part 2, invite withdrawal:
- `scripts/add-linkedin-invite-withdrawal.ts` (enum value `WITHDRAWN` on "LeadStatus"; `withdrawAfterWorkingDays`; `Lead.inviteWithdrawnAt`)
- `src/services/unipile.service.ts` (`cancelInvitation` via SDK `users.cancelInvitationSent`; `findSentInvitationId` fallback)
- `src/lib/linkedin/workingHours.ts` (new `workingDaysElapsed`, in the account's time zone and work days)
- `src/functions/withdrawInvitations.ts` (new), called from `src/jobs/runOutreach.ts` after `sendInvitations`
- `src/lib/channels/rules.ts` (Sending rule `inviteWithdrawalsPerRun`, default 2 to 4)
- `REPLY_STATUSES` gets WITHDRAWN; labels in metrics, leads list and lead panel; wizard and edit field

Part 3, email hand-off:
- `scripts/add-linkedin-email-handoff.ts` (two Campaign FKs; `Lead.completedAt`, `emailHandoffAt`, `emailHandoffCampaignId`, `emailHandoffResult`)
- `src/functions/sendFollowUps.ts` (stamp `completedAt` on every COMPLETED write)
- `src/lib/leads/campaignAssignments.ts` (split out `addPeopleToEmailCampaignInTransaction`, rules unchanged)
- `src/lib/linkedin/emailHandoff.ts` (pure decision) and `emailHandoff.server.ts` (`handOffLinkedinLeadsToEmail`, once per organization per outreach run, max 50, one transaction per lead)
- API validation of both campaign ids with `inOrg`; two email-campaign pickers in the wizard and edit form; hand-off result in the lead panel
- `scripts/e2e/linkedin-email-handoff.ts` (new, local DB only)

## Order of work
1. Part 1, then Part 2, then Part 3; each is shippable alone and keeps today's behaviour when its settings are off.
2. Each part: migration and Drizzle schema together, engine change, API, minimal UI, docs and CHANGELOG, tests, `bun run db:schema:dump`.
3. Hand-off transaction order: take `lockPersonContactPolicyScope(tx, personId)` first (reply ingest takes the same lock), claim the lead with `emailHandoffAt IS NULL`, re-check for a late accept (WITHDRAWN with a Connection row goes back to REQUEST_SENT), run the guards (DNC, replied, active in another email campaign, no email), enroll, write the result.
4. Withdrawal: claim (status WITHDRAWN) and commit before calling Unipile; on "cancelled" or "gone" keep it; on any other error set it back to REQUEST_SENT and count a retry (max 3). Before cancelling, check the profile is not already first-degree (no accept poll exists).
5. Deploy to the VPS only after VJ's OK: run the three migration scripts, rebuild, then set the settings on our campaign.

## Tests that prove it
- Existing: `npm test` (bun), `npx tsc --noEmit`, `bun run lint`, `bun run db:check`, tenancy isolation e2e, plus the 19 Nov cross-channel stop proof script (must still print RESULT: PASS).
- New: default delays still give 24/48/72h and ours give +1/+4/+8/+12/+19; a gap before follow-up 4 is refused; `REPLY_STATUSES` helper counts CONNECTED, FOLLOW_UP_3_SENT and WITHDRAWN as replies; `workingDaysElapsed` (Mon to Fri, Mon to Sat default, 23:30 IST rollover, US daylight-saving week, no hours set); Unipile cancel maps 404 to "gone"; hand-off decision table; e2e on a throwaway DB: two runs give one enrollment, DNC / replied / already-in-campaign people skipped, a reply racing the hand-off leaves no active enrollment, leads completed before the migration are never handed off; migration self-check that the unique index includes FOLLOW_UP_4.
- Manual: on the VPS, one test campaign with Arjun's own profile and a colleague as the lead; check the timings and the withdrawal on the lead panel.

## Risks
- LinkedIn account safety: withdrawals are paced by the per-run rule and working hours; LinkedIn may block re-inviting a withdrawn person for a while.
- AgentSDR's default work days are Mon to Sat; set our accounts to Mon to Fri so Saturday does not count toward Day 4.
- A paused or draft email campaign A/B leaves hand-offs as `pending` until it is launched.
- Our fork drifts from upstream; offering each part back as a PR keeps that small.

## Rollback
- Per campaign: put the settings back to their defaults (no deploy).
- Code: revert the commits; the new columns are additive and can stay; Postgres cannot drop enum values (harmless). Before reverting Part 1 run `UPDATE "Lead" SET status='REQUEST_SENT' WHERE status='CONNECTED'`.
- Undo hand-off enrollments with `POST /api/v1/campaigns/:id/leads/stop` using `emailHandoffCampaignId`.

## Deviations
- Enrollment uses the "Add from People" path (`addPeopleToEmailCampaign`, takes Person ids) instead of the public API path, which re-finds people by email. Same suppression and duplicate rules.
- Existing bugs fixed on the way: `REPLY_STATUSES` (message-received webhook) drops replies from CONNECTED leads, so they would not stop outreach (verified 20 Nov, line 22); the automated-message unique index must include FOLLOW_UP_4 or it could double-send; `migrationParity.ts` hard-codes 24/48/72h; nothing polls accepted connections (`getAcceptedConnections` has no caller, verified 20 Nov).
- The fork's CLAUDE.md says work on main without PRs; BigBoost's SDLC and upstream CONTRIBUTING.md want a branch and PR. We use `feat/lender-flow` and PRs.
