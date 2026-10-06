# Native advisor tool vs the ladder's consult_oracle

Written for issue #9 (step 3). Read 2026-10-04. **How it was read:** the Claude Code page
(`code.claude.com/docs/en/advisor`) came back whole through a summarising fetch; the API page
(`platform.claude.com/.../advisor-tool`) was too large and only its first part was seen. Nothing
below was tested live. Items marked *inferred* are my reading of the docs, not documented behaviour.

## What exists (documented)

- Claude Code ships an **advisor**: a stronger model that the main model can consult mid-task.
  Set with `/advisor <model>`, the `advisorModel` setting, or `claude --advisor <model>`.
- It is a **server tool** on the Anthropic API only (not Bedrock, Vertex, Foundry). It needs
  feature-flag fetching on, so `DISABLE_TELEMETRY` and similar turn it off. `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` removes it.
- **The main model decides when to call it.** There is no setting to cap or force calls; you steer it by saying so in the prompt.
- The advisor sees the **full conversation** including tool calls and results, and returns guidance. No cap parameter in Claude Code.
- **Works over Remote Control** (and desktop, `-p`, the Agent SDK): `/advisor` with no argument prints the current advisor, `/advisor <model>` sets it, `/advisor off` clears it. Needs Claude Code 2.1.260 or later.
- **Pairing rule:** the advisor must rank at or above the main model. From the docs table: Haiku 4.5 accepts Fable/Opus/Sonnet; Sonnet 5.5 accepts Fable, Opus 5 or later, Sonnet 5.5; Opus 5 / 5.5 accepts Fable or Opus 5 or later. Haiku can call an advisor but cannot be one. A below-rank advisor is simply not attached.
- If the **API refuses a pairing** Claude Code attached, it resends the request without the advisor, silently, and the advisor stays off until `/clear` or `/compact`, even after you switch models.
- **Cache:** toggling `/advisor` does not invalidate the main model's cache. The advisor's own read of the transcript is not cached; each call processes the full transcript anew.
- **Cost:** advisor tokens bill at the advisor model's rates and count in `/usage`.
- Subagents inherit the configured advisor and are checked against their own model.

## Overlap with consult_oracle

| | consult_oracle (ours) | native advisor |
|---|---|---|
| Who calls it | the main model, via our MCP tool | the main model, via a server tool |
| What the stronger model sees | last 80 rows of the session | the full conversation |
| Can it use tools | no | no (advice only) |
| Cap | none yet (issue 10) | none in Claude Code |
| Works on a phone / Remote Control | yes (it is a tool) | yes (`/advisor` is a command) |
| Visible to the mod | yes, we are the tool | not documented for mods |
| Cache | fresh prompt, no cache | cache not reused by the advisor |

It is the same idea, so the native one is the likely long-term replacement for the consult half.

## Interactions with the ladder (inferred, to test)

1. **The ladder changes the main model per request; the pairing rule is about the main model.** If Claude Code checks the pairing against the session model while the ladder rewrites the request model, the advisor may be attached to a request on a rung it does not pair with. If the API then refuses, the advisor is silently off for the rest of the conversation. *Safest setting to test first:* `/advisor opus` (Opus 5 or later), which the table pairs with every rung we use: Haiku 4.5, Sonnet 5.5, Opus 5.5. A Sonnet advisor would stop pairing the moment the ladder reaches the oracle rung.
2. **Double escalation.** The ladder can move to Opus while the advisor is also Opus. That is not wrong, but the two mechanisms are not coordinated: the ladder cannot tell that an advisor consult already happened.
3. **Spend accounting.** Advisor tokens show in `/usage` but not in the ladder's per-tier spend table or `/ladder status`.
4. **Visibility.** The mod typings available here do not mention the advisor at all. Whether it appears to `tool.call` or in a `turn.step` result's `toolUses` is unknown, so the ladder may not be able to count consults without help.
5. **Prompt steering.** Anthropic reports executors under-call the advisor on coding tasks and publishes a prompt block for it (vendor-reported). A mod can edit system-prompt sections (`prompt.section`, `prompt.compose`) but doing so changes the system prompt on every request, which costs one cache re-write when the ladder is toggled and needs tuned wording. Not done; needs a decision.

## Recommendation

Keep `consult_oracle`; do not replace it yet. Run these live checks, in order, then decide:

1. With the ladder on at a low rung, run `/advisor opus`, do a task, and read `/ladder status` and `/usage`. Does the advisor appear (an "Advising" line) and what does it cost?
2. Let the ladder escalate to the oracle rung with the advisor still set. Does consulting keep working, or does it silently stop (the refusal path)?
3. Check whether advisor calls are visible to the mod: add a temporary log of `tool.call` and `turn.step` `toolUses` names during step 1.

If 1-3 are clean, the plan is: advisor for planning/consult moments, the ladder for the move-up/move-down decisions, `consult_oracle` demoted to a fallback for non-Anthropic-API setups.

## Live results (2026-10-04)

**Check 1 — advisor attaches and answers on a rewritten rung.**
- **Passed:** `/advisor opus` + task run at rung 1 (worker: `claude-sonnet-5-5`/medium) attached the advisor and answered on a tool call.
- **Cost and "Advising" line:** visible only in `/usage` — ask the user for it.
- **Rung 0 (scout) untested:** the ladder started there, escalated to rung 1 on step 25 (stall heuristic). No advisor call at rung 0.

**Check 2 — advisor survives escalation to oracle.**
- **Not exercised:** the run peaked at rung 1. Requires `/ladder up` twice to reach oracle (pin the rung), then a single tool call. Then `/ladder unpin`.

**Check 3 — advisor visibility to the mod.**
- **Inconclusive:** the state read didn't align with the advisor call. Requires a temporary tool.call log as described (point 3 in Recommendation, above).

**Ladder note:** scout → worker escalation on step-count stall (25 steps, healthy metrics: error streak 0, no loops) = false positive of the maxStepsPerTier heuristic on clean iteration. Worth tracking for the spike.

## Done under issue #9 so far

- A stated confidence no longer vetoes an escalation request once the run shows an error streak or a loop strike (behaviour outranks the hint).
- Per-task counters for escalation requests and oracle consults, shown in `/ladder status`.
- Live advisor integration check #1 (attachment and answer on rewritten tier).

Not done: prompt steering (point 5), checks #2 and #3, cost details from `/usage`.
