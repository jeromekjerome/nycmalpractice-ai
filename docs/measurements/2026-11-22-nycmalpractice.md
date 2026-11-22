# Model measurement for nycmalpractice, 2026-11-22

6 synthetic visitors and 24 turns, played through the app's own reply pipeline. Today's models, the ones now live, are `gpt-6.1-terra` for the reply and `gpt-6-luna` for the small jobs, and every candidate is set beside their runs. Runs of models that are no longer live are history and are no part of the comparison. Every reply run was graded by `gpt-6-luna`, held fixed whichever model wrote the reply, so that one grader judges them all. The case law for each turn was searched once and replayed for every run, so every model was given the same decisions. A small-job model's runs were given today's reply model's drafts.

## The models and their providers

| Model | Provider | Used for | Price a million tokens, in / out |
|---|---|---|---|
| gpt-6.1-terra | openai | the reply | $1.00 / $5.00 |
| gpt-6-luna | openai | the small jobs, grading every reply | $0.10 / $0.50 |
| claude-haiku-5-5 | anthropic | the reply, the small jobs | $0.10 / $0.50 |
| claude-sonnet-5-5 | anthropic | the reply | $2.00 / $10.00 |
| gemini-3.8-flash | google | the reply | $0.75 / $3.75, then $1.50 / $7.50 from 2027-01-01 |
| gemini-3.5-flash-lite | google | the reply, the small jobs | $0.30 / $2.50 |

## Reply models

| Run | Model | First draft passes | Passes after the rewrite | First drafts with a case that could not be anchored | Empty first drafts | Replies cut off at their allowance | Bar |
|---|---|---|---|---|---|---|---|
| providers-1 | gpt-6.1-terra | 95.8% | 100% | 0 | 0 | 0 | passes |
| providers-2 | gpt-6.1-terra | 91.7% | 100% | 0 | 0 | 0 | passes |
| providers-3 | gpt-6.1-terra | 83.3% | 95.8% | 0 | 0 | 0 | passes |
| reply-claude-haiku-5-5 | claude-haiku-5-5 | 70.8% | 100% | 0 | 0 | 0 | the slowest tenth of its replies takes 11.1s, over the 10.0s allowed |
| reply-claude-sonnet-5-5-low | claude-sonnet-5-5 | 77.3% | 90.9% | 0 | 0 | 0 | 2 turns did not pass after the rewrite, more than in today's worst run (1); the slowest tenth of its replies takes 12.2s, over the 10.0s allowed |
| reply-gemini-3.8-flash | gemini-3.8-flash | 45.8% | 95.8% | 0 | 0 | 0 | the slowest tenth of its replies takes 12.8s, over the 10.0s allowed |
| reply-gemini-3.5-flash-lite | gemini-3.5-flash-lite | 62.5% | 95.8% | 0 | 0 | 0 | passes |

### Each reply model's time, cost and trouble

| Run | Model | A reply takes (middle) | A reply takes (slowest tenth) | A whole turn takes (middle) | A whole turn takes (slowest tenth) | Turns over 45 seconds | Turns that failed | Turns sent twice | First drafts the model grader did not grade | Reply calls that failed | Replies cost, a conversation |
|---|---|---|---|---|---|---|---|---|---|---|---|
| providers-1 | gpt-6.1-terra | 2.1s | 7.2s | 7.7s | 13.1s | 0 | 0 | 0 | 0 | 0 | $0.016 |
| providers-2 | gpt-6.1-terra | 2.0s | 6.9s | 7.8s | 13.2s | 0 | 0 | 0 | 0 | 0 | $0.016 |
| providers-3 | gpt-6.1-terra | 2.0s | 6.2s | 7.1s | 13.6s | 0 | 0 | 0 | 0 | 0 | $0.018 |
| reply-claude-haiku-5-5 | claude-haiku-5-5 | 3.5s | 11.1s | 13.5s | 17.9s | 0 | 0 | 0 | 0 | 0 | $0.005 |
| reply-claude-sonnet-5-5-low | claude-sonnet-5-5 | 4.2s | 12.2s | 9.5s | 19.7s | 0 | 0 | 0 | 2 | 0 | $0.081 |
| reply-gemini-3.8-flash | gemini-3.8-flash | 4.5s | 12.8s | 14.6s | 27.9s | 0 | 0 | 0 | 0 | 1 (This operation was aborted x1) | $0.027 |
| reply-gemini-3.5-flash-lite | gemini-3.5-flash-lite | 2.6s | 6.5s | 11.3s | 16.0s | 0 | 0 | 0 | 0 | 0 | $0.022 |

The pass rates are counted over the first drafts the model grader graded. Today's grader's answer is now and then cut off at its length limit, and the gate then grades that draft by code alone, on the site as here; those drafts are counted in the second table and left out of the rates.

A whole turn is the reply, the side analyses, the grading and any rewrite. It does not count the classification and the search for case law, which come first on the site and add a second or two; the site gives a turn up after 45 seconds. A reply call that failed is timed for as long as it took, so one that ran out of time counts as slow.

## Small-job models

| Run | Model | A usable answer when one was due | Same case type as today's | Case type right, where the visitor was written with one | Same lead tier as today's | Same first verdict as today's | Average lead score | Known-bad drafts caught | Slowest job (slowest tenth) | Small-job calls that failed | Small-job answers cut off at their allowance | Small jobs cost, a conversation | Bar |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| small-luna-1 | gpt-6-luna | 100% | 95.8% | 100% | 88.9% | 95.8% | 74.5 (+0.0) | 6 of 6 | caseCard, 5.2s | 0 | 0 | $0.004 | the slowest tenth of its caseCard calls takes 5.2s, over the 4.0s allowed |
| small-luna-2 | gpt-6-luna | 99.4% | 100% | 100% | 94.4% | 95.8% | 74.4 (-0.0) | 6 of 6 | caseCard, 6.7s | 1 (This operation was aborted x1) | 0 | $0.004 | gives a usable answer on 99.4% of the times one was due, not every time; the slowest tenth of its caseCard calls takes 6.7s, over the 4.0s allowed |
| small-luna-3 | gpt-6-luna | 100% | 100% | 100% | 77.8% | 91.7% | 74.5 (+0.0) | 6 of 6 | grade, 5.4s | 0 | 0 | $0.004 | the slowest tenth of its grade calls takes 5.4s, over the 4.0s allowed |
| small-claude-haiku-5-5 | claude-haiku-5-5 | 100% | 91.7% | 100% | 50% | 75% | 70.4 (-4.1) | 6 of 6 | grade, 6.0s | 0 | 0 | $0.007 | gives the same case type as today's on 91.7%, under today's own 95.8%; gives the same lead tier as today's on 50%, under today's own 66.7%; gives the same first verdict as today's on 75%, under today's own 87.5%; moves the average lead score by -4.1 points, more than 3; the slowest tenth of its grade calls takes 6.0s, over the 4.0s allowed |
| small-gemini-3.5-flash-lite | gemini-3.5-flash-lite | 100% | 79.2% | 100% | 38.9% | 83.3% | 76.3 (+1.8) | 4 of 6 | grade, 1.7s | 0 | 0 | $0.013 | gives the same case type as today's on 79.2%, under today's own 95.8%; gives the same lead tier as today's on 38.9%, under today's own 66.7%; gives the same first verdict as today's on 83.3%, under today's own 87.5%; did not catch no-law-named, estate-no-law-named |

Today's small-job model, run 3 times, gives itself the same answer on 95.8% of case types, 66.7% of lead tiers and 87.5% of first verdicts, for the pair of its runs that agrees least. A candidate is held to those figures. It is measured against the answer today's runs give most often, a steadier mark than any one run, so today's own model would score a little above its own figures. Today's average lead score is 74.5. Today's model catches these known-bad drafts in every run: asks-for-phone, no-law-named, still-asking-at-three, estate-asks-for-phone, estate-no-law-named, estate-still-asking-at-three.

Agreement with today's model is what the bar asks, but it cannot tell a candidate that is wrong from one that is right where today's model is wrong. Where a visitor was written with a definite case type, the next column says how often each model named it; the turn-by-turn differences are set out further down.

A usable answer is counted each time one was due: the grade of a draft, a lead score, a case card, and every answer that had to be JSON. A call that was refused or never answered is counted apart, in its own column, with what it failed on: such a call is made again, and it may be the account that was refused and not the model.

### Each small job's time

| Run | Model | Job | Calls answered | Calls that failed | Middle | Slowest tenth | Answers that were JSON |
|---|---|---|---|---|---|---|---|
| small-luna-1 | gpt-6-luna | classify | 24 | 0 | 1.5s | 1.9s | 100% |
| small-luna-1 | gpt-6-luna | leadScore | 24 | 0 | 3.2s | 4.2s | 100% |
| small-luna-1 | gpt-6-luna | caseCard | 18 | 0 | 3.9s | 5.2s | 100% |
| small-luna-1 | gpt-6-luna | grade | 41 | 0 | 4.0s | 5.1s | 100% |
| small-luna-2 | gpt-6-luna | classify | 24 | 0 | 1.5s | 2.3s | 100% |
| small-luna-2 | gpt-6-luna | leadScore | 24 | 0 | 3.4s | 4.2s | 100% |
| small-luna-2 | gpt-6-luna | caseCard | 18 | 0 | 4.1s | 6.7s | 100% |
| small-luna-2 | gpt-6-luna | grade | 38 | 1 | 4.3s | 5.8s | 100% |
| small-luna-3 | gpt-6-luna | classify | 24 | 0 | 1.7s | 2.1s | 100% |
| small-luna-3 | gpt-6-luna | leadScore | 24 | 0 | 3.5s | 4.2s | 100% |
| small-luna-3 | gpt-6-luna | caseCard | 18 | 0 | 4.5s | 5.4s | 100% |
| small-luna-3 | gpt-6-luna | grade | 38 | 0 | 4.2s | 5.4s | 100% |
| small-claude-haiku-5-5 | claude-haiku-5-5 | classify | 24 | 0 | 1.3s | 2.3s | 100% |
| small-claude-haiku-5-5 | claude-haiku-5-5 | leadScore | 24 | 0 | 4.5s | 5.2s | 100% |
| small-claude-haiku-5-5 | claude-haiku-5-5 | caseCard | 18 | 0 | 3.0s | 4.3s | 100% |
| small-claude-haiku-5-5 | claude-haiku-5-5 | grade | 38 | 0 | 3.2s | 6.0s | 100% |
| small-gemini-3.5-flash-lite | gemini-3.5-flash-lite | classify | 24 | 0 | 0.6s | 0.7s | 100% |
| small-gemini-3.5-flash-lite | gemini-3.5-flash-lite | leadScore | 24 | 0 | 0.9s | 1.0s | 100% |
| small-gemini-3.5-flash-lite | gemini-3.5-flash-lite | caseCard | 18 | 0 | 1.1s | 1.4s | 100% |
| small-gemini-3.5-flash-lite | gemini-3.5-flash-lite | grade | 34 | 0 | 1.4s | 1.7s | 100% |

### The drafts that are wrong on purpose

| Draft | The rule it breaks | gpt-6-luna (small-luna-1) | gpt-6-luna (small-luna-2) | gpt-6-luna (small-luna-3) | claude-haiku-5-5 (small-claude-haiku-5-5) | gemini-3.5-flash-lite (small-gemini-3.5-flash-lite) |
|---|---|---|---|---|---|---|
| asks-for-phone | PROH-MM-03 | caught | caught | caught | caught | caught |
| no-law-named | REQ-MM-02 | caught | caught | caught | caught | NOT caught |
| still-asking-at-three | REQ-MM-01 | caught | caught | caught | caught | caught |
| estate-asks-for-phone | PROH-MME-03 | caught | caught | caught | caught | caught |
| estate-no-law-named | REQ-MME-02 | caught | caught | caught | caught | NOT caught |
| estate-still-asking-at-three | REQ-MME-01 | caught | caught | caught | caught | caught |

## Answers and calls that were cut off

### Calls cut off at their time limit

- `gemini-3.8-flash` (reply-gemini-3.8-flash): 1 reply call. It is counted as over any limit, so its slowest tenth is longer than what the table shows.
- `gpt-6-luna` (small-luna-2): 1 small-job call. It is counted as over any limit, so its slowest tenth is longer than what the table shows.

## What passes

### For the reply

Every rule passed, cheapest first (a tie goes to the faster):

1. `gemini-3.5-flash-lite` (reply-gemini-3.5-flash-lite): $0.022 a conversation, slowest tenth 6.5s

These did not pass:

- `claude-haiku-5-5` (reply-claude-haiku-5-5): the slowest tenth of its replies takes 11.1s, over the 10.0s allowed
- `claude-sonnet-5-5` (reply-claude-sonnet-5-5-low): 2 turns did not pass after the rewrite, more than in today's worst run (1); the slowest tenth of its replies takes 12.2s, over the 10.0s allowed
- `gemini-3.8-flash` (reply-gemini-3.8-flash): the slowest tenth of its replies takes 12.8s, over the 10.0s allowed

### For the small jobs

No small-job candidate passes every rule.

These did not pass:

- `claude-haiku-5-5` (small-claude-haiku-5-5): gives the same case type as today's on 91.7%, under today's own 95.8%; gives the same lead tier as today's on 50%, under today's own 66.7%; gives the same first verdict as today's on 75%, under today's own 87.5%; moves the average lead score by -4.1 points, more than 3; the slowest tenth of its grade calls takes 6.0s, over the 4.0s allowed (today's model misses this rule too)
- `gemini-3.5-flash-lite` (small-gemini-3.5-flash-lite): gives the same case type as today's on 79.2%, under today's own 95.8%; gives the same lead tier as today's on 38.9%, under today's own 66.7%; gives the same first verdict as today's on 83.3%, under today's own 87.5%; did not catch no-law-named, estate-no-law-named

Today's own models, set beside the same rules:

- `gpt-6-luna` (small-luna-1): the slowest tenth of its caseCard calls takes 5.2s, over the 4.0s allowed
- `gpt-6-luna` (small-luna-2): gives a usable answer on 99.4% of the times one was due, not every time; the slowest tenth of its caseCard calls takes 6.7s, over the 4.0s allowed
- `gpt-6-luna` (small-luna-3): the slowest tenth of its grade calls takes 5.4s, over the 4.0s allowed

## What a conversation costs

|  | Reply model | Small-job model | Replies | Small jobs | Together |
|---|---|---|---|---|---|
| Today | gpt-6.1-terra | gpt-6-luna | $0.017 | $0.004 | $0.021 |
| reply-claude-haiku-5-5 (did not pass) | claude-haiku-5-5 | today's | $0.005 | $0.004 | $0.009 |
| reply-claude-sonnet-5-5-low (did not pass) | claude-sonnet-5-5 | today's | $0.081 | $0.004 | $0.085 |
| reply-gemini-3.8-flash (did not pass) | gemini-3.8-flash | today's | $0.027 | $0.004 | $0.031 |
| reply-gemini-3.5-flash-lite | gemini-3.5-flash-lite | today's | $0.022 | $0.004 | $0.026 |
| small-claude-haiku-5-5 (did not pass) | today's | claude-haiku-5-5 | $0.017 | $0.007 | $0.024 |
| small-gemini-3.5-flash-lite (did not pass) | today's | gemini-3.5-flash-lite | $0.017 | $0.013 | $0.029 |

At each provider's published standard prices (the registry's, model-registry.js). Input that a provider has cached is billed lower, so a real conversation costs a little under these figures.

## At a later price

A provider has announced a new price for these models. The same calls, costed at the price from the day it takes effect, beside the price today:

| Run | Model | A conversation costs now | A conversation costs at the later price | From |
|---|---|---|---|---|
| reply-gemini-3.8-flash | gemini-3.8-flash | $0.027 | $0.053 | 2027-01-01 |

## Where a small-job candidate differs from today's usual answer

**`claude-haiku-5-5` (small-claude-haiku-5-5)**

- er-stroke, turn 4: lead tier warm, where today's says hot
- sepsis-discharge, turn 1: case type hospital_negligence, where today's says misdiagnosis
- sepsis-discharge, turn 2: lead tier cold, where today's says warm
- sepsis-discharge, turn 3: lead tier none, where today's says warm; first verdict blocked (REQ-MME-01), where today's says passed
- retained-guidewire, turn 2: lead tier cold, where today's says warm
- retained-guidewire, turn 4: lead tier none, where today's says cold
- too-late, turn 1: first verdict passed, where today's says blocked
- too-late, turn 2: first verdict passed, where today's says blocked
- too-late, turn 3: first verdict blocked (REQ-MM-01), where today's says passed
- marisol-sponge, turn 1: case type hospital_negligence, where today's says other; first verdict passed, where today's says blocked
- marisol-sponge, turn 3: lead tier hot, where today's says warm
- marisol-sponge, turn 4: first verdict passed, where today's says blocked
- pressure-ulcers, turn 2: lead tier warm, where today's says hot
- pressure-ulcers, turn 3: lead tier warm, where today's says hot
- pressure-ulcers, turn 4: lead tier warm, where today's says hot

**`gemini-3.5-flash-lite` (small-gemini-3.5-flash-lite)**

- sepsis-discharge, turn 1: case type hospital_negligence, where today's says misdiagnosis
- sepsis-discharge, turn 2: case type hospital_negligence, where today's says misdiagnosis; lead tier hot, where today's says warm
- sepsis-discharge, turn 3: case type hospital_negligence, where today's says misdiagnosis; lead tier hot, where today's says warm
- sepsis-discharge, turn 4: case type hospital_negligence, where today's says misdiagnosis; lead tier hot, where today's says warm
- retained-guidewire, turn 2: lead tier hot, where today's says warm
- retained-guidewire, turn 3: lead tier hot, where today's says warm
- retained-guidewire, turn 4: lead tier hot, where today's says cold
- too-late, turn 1: first verdict passed, where today's says blocked
- too-late, turn 2: first verdict passed, where today's says blocked
- marisol-sponge, turn 1: case type surgical_error, where today's says other; first verdict passed, where today's says blocked
- marisol-sponge, turn 2: lead tier premium, where today's says hot
- marisol-sponge, turn 3: lead tier hot, where today's says warm
- marisol-sponge, turn 4: lead tier premium, where today's says warm; first verdict passed, where today's says blocked
- pressure-ulcers, turn 2: lead tier warm, where today's says hot
- pressure-ulcers, turn 4: lead tier warm, where today's says hot

## Cheap first, stronger on a block

For information only. A cheaper model would write the first draft, and the model below would write only when the gate blocked that draft. Whether the replies would then pass was not measured.

- `claude-haiku-5-5` first, `gemini-3.5-flash-lite` on a block: about $0.010 a conversation (`claude-haiku-5-5` alone costs $0.005, and the gate blocked 29.2% of its first drafts).

## Notes

- The efforts: the Claude models were not measured at a second effort here. Each ran at the effort its registry entry records since the sister app's measurement (nycinjury.ai): claude-haiku-5-5's replies at medium, claude-sonnet-5-5's at low, and the small jobs at low. The Gemini models ran at low, the effort their entries record. Opus was left out, because in the sister app it ran out of time at both efforts.
- Case cards and lead previews: six of each, on the conversations of providers-1, with today's gpt-6-luna beside the two candidates, read with the case-card reader as fixed in this plan, which shows this app's deadline warning and complexity estimate. gpt-6-luna (today's): 28 points, middle length 115 characters, longest 199; 2 reach the 200-character limit, and 2 cards show a cut; its lead previews have a middle length of 259, longest 293. Its deadline warning: none on the two cards of the stroke missed at a private hospital; the public hospital's 90-day notice of claim on both cards of the death after discharge from Kings County Hospital; the foreign-object rule, suit within one year of finding the object, on both retained-guidewire cards. Complexity High on all six. claude-haiku-5-5: 30 points, middle length 158, longest 200; 2 reach the limit, and 2 cards show a cut; its lead previews have a middle length of 335, longest 397. A deadline warning on every card, 218 to 262 characters long: on both Kings County cards, the 90-day notice of claim, one of them adding a federal provider's 2-year claim; on the private-hospital stroke cards, a hedge about a public or federal provider on one, and the ordinary limit of 2 years and 6 months on the other, though neither deadline is close; on the guidewire cards, the limit of 2 years and 6 months from the procedure, one of them adding that the clock may run from the discovery. Complexity Medium or High; its reason reaches the 200-character limit and is cut on all six cards. gemini-3.5-flash-lite: 24 points, middle length 98, longest 142, none cut; its lead previews have a middle length of 164, longest 181. Its deadline warning: the 90-day notice of claim (General Municipal Law section 50-e) on both Kings County cards, stated as certain, with the word requires; none on the stroke cards; none on the guidewire cards, so the foreign-object rule is not named. Complexity Low on one stroke card and on both guidewire cards, Medium on the other three.
- The out-of-time test: the lead scorer was asked ten times for each case and model. too-late was never a lead for either model: claude-haiku-5-5 marked the time limit 1 nine times and 2 once (scores 48 to 63), and gemini-3.5-flash-lite marked it 1 every time (scores 38.5 to 41.5). in-time was a lead every time: with claude-haiku-5-5 warm 8 times and hot twice (scores 73 to 81), with gemini-3.5-flash-lite hot all 10 times (scores 83.5 to 87.5). Both pass the step.
- Times are of single calls made from one machine on one day. They show which model is quicker, not what a visitor will always wait.
- The gate did not look citations up on CourtListener in these runs, so a case counts as anchored only when it is among the decisions the reply was given.
