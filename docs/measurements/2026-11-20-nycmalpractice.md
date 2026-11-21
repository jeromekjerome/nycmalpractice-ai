# Model measurement for nycmalpractice, 2026-11-20

6 synthetic visitors and 24 turns, played through the app's own reply pipeline. Today's models are `gpt-4o` for the reply and `gpt-4o-mini` for the small jobs. The case law for each turn was searched once and replayed for every run, so every model was given the same decisions. A reply model's runs were graded by today's small model. A small-job model's runs were given today's reply model's drafts.

## Reply models

| Run | Model | First draft passes | Passes after the rewrite | First drafts with a case that could not be anchored | Empty first drafts | Replies cut off | Bar |
|---|---|---|---|---|---|---|---|
| base-1 | gpt-4o | 87.5% | 91.7% | 0 | 0 | 0 | passes |
| base-2 | gpt-4o | 95.8% | 95.8% | 0 | 0 | 0 | passes |
| base-3 | gpt-4o | 91.7% | 100% | 0 | 0 | 0 | passes |
| reply-gpt-6.2-sol | gpt-6.2-sol | 79.2% | 87.5% | 0 | 0 | 0 | 3 turns did not pass after the rewrite, more than in today's worst run (2) |
| reply-gpt-6.1-terra | gpt-6.1-terra | 83.3% | 95.8% | 0 | 0 | 0 | passes |
| reply-gpt-6-luna | gpt-6-luna | 75% | 95.8% | 0 | 0 | 0 | passes |
| reply-gpt-5.4 | gpt-5.4 | 83.3% | 100% | 0 | 0 | 0 | the slowest tenth of its replies takes 11.8s, over the 10.0s allowed |
| reply-gpt-5.4-mini | gpt-5.4-mini | 73.9% | 95.7% | 0 | 0 | 0 | passes |

### Each reply model's time, cost and trouble

| Run | Model | A reply takes (middle) | A reply takes (slowest tenth) | A whole turn takes (middle) | A whole turn takes (slowest tenth) | Turns over 45 seconds | Turns that failed | Turns sent twice | First drafts the model grader did not grade | Reply calls that failed | Replies cost, a conversation |
|---|---|---|---|---|---|---|---|---|---|---|---|
| base-1 | gpt-4o | 1.1s | 2.2s | 6.4s | 11.5s | 0 | 0 | 0 | 0 | 0 | $0.042 |
| base-2 | gpt-4o | 1.0s | 2.1s | 6.7s | 8.1s | 0 | 0 | 0 | 0 | 0 | $0.037 |
| base-3 | gpt-4o | 1.0s | 2.1s | 6.9s | 11.7s | 0 | 0 | 0 | 0 | 0 | $0.039 |
| reply-gpt-6.2-sol | gpt-6.2-sol | 2.6s | 8.1s | 7.4s | 14.1s | 0 | 0 | 0 | 0 | 0 | $0.043 |
| reply-gpt-6.1-terra | gpt-6.1-terra | 2.4s | 6.6s | 7.1s | 13.9s | 0 | 0 | 0 | 0 | 0 | $0.019 |
| reply-gpt-6-luna | gpt-6-luna | 2.1s | 6.6s | 10.0s | 14.3s | 0 | 0 | 0 | 0 | 0 | $0.002 |
| reply-gpt-5.4 | gpt-5.4 | 4.4s | 11.8s | 13.3s | 20.8s | 0 | 0 | 0 | 0 | 0 | $0.072 |
| reply-gpt-5.4-mini | gpt-5.4-mini | 1.6s | 4.8s | 7.8s | 14.1s | 0 | 0 | 0 | 1 | 0 | $0.022 |

The pass rates are counted over the first drafts the model grader graded. Today's grader's answer is now and then cut off at its length limit, and the gate then grades that draft by code alone, on the site as here; those drafts are counted in the second table and left out of the rates.

A whole turn is the reply, the side analyses, the grading and any rewrite. It does not count the classification and the search for case law, which come first on the site and add a second or two; the site gives a turn up after 45 seconds. A reply call that failed is timed for as long as it took, so one that ran out of time counts as slow.

## Small-job models

| Run | Model | A usable answer when one was due | Same case type as today's | Case type right, where the visitor was written with one | Same lead tier as today's | Same first verdict as today's | Average lead score | Known-bad drafts caught | Slowest job (slowest tenth) | Small-job calls that failed | Small jobs cost, a conversation | Bar |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| small-base-1 | gpt-4o-mini | 100% | 95.8% | 0% | 61.1% | 91.7% | 72.0 (-1.3) | 2 of 6 | grade, 7.5s | 0 | $0.005 | the slowest tenth of its grade calls takes 7.5s, over the 4.0s allowed |
| small-base-2 | gpt-4o-mini | 100% | 100% | 0% | 83.3% | 100% | 73.5 (+0.3) | 3 of 6 | grade, 5.6s | 0 | $0.005 | the slowest tenth of its grade calls takes 5.6s, over the 4.0s allowed |
| small-base-3 | gpt-4o-mini | 100% | 95.8% | 0% | 83.3% | 100% | 74.2 (+1.0) | 3 of 6 | grade, 5.7s | 0 | $0.005 | the slowest tenth of its grade calls takes 5.7s, over the 4.0s allowed |
| small-gpt-6-luna | gpt-6-luna | 100% | 79.2% | 100% | 61.1% | 70.8% | 76.1 (+2.9) | 6 of 6 | grade, 6.4s | 0 | $0.005 | gives the same case type as today's on 79.2%, under today's own 91.7%; gives the same first verdict as today's on 70.8%, under today's own 91.7%; the slowest tenth of its grade calls takes 6.4s, over the 4.0s allowed |
| small-gpt-5.4-mini | gpt-5.4-mini | 100% | 83.3% | 100% | 44.4% | 66.7% | 81.3 (+8.0) | 6 of 6 | grade, 3.0s | 0 | $0.037 | gives the same case type as today's on 83.3%, under today's own 91.7%; gives the same first verdict as today's on 66.7%, under today's own 91.7%; moves the average lead score by 8.0 points, more than 3 |
| small-gpt-5.4-nano | gpt-5.4-nano | 99.4% | 87.5% | 0% | 55.6% | 70.8% | 77.3 (+4.0) | 6 of 6 | grade, 5.3s | 0 | $0.012 | gives a usable answer on 99.4% of the times one was due, not every time; gives the same case type as today's on 87.5%, under today's own 91.7%; gives the same first verdict as today's on 70.8%, under today's own 91.7%; moves the average lead score by 4.0 points, more than 3; the slowest tenth of its grade calls takes 5.3s, over the 4.0s allowed |
| small-gpt-6.1-terra | gpt-6.1-terra | 100% | 70.8% | 100% | 55.6% | 62.5% | 76.6 (+3.3) | 6 of 6 | grade, 5.3s | 0 | $0.039 | gives the same case type as today's on 70.8%, under today's own 91.7%; gives the same first verdict as today's on 62.5%, under today's own 91.7%; moves the average lead score by 3.3 points, more than 3; the slowest tenth of its grade calls takes 5.3s, over the 4.0s allowed |

Today's small-job model, run 3 times, gives itself the same answer on 91.7% of case types, 44.4% of lead tiers and 91.7% of first verdicts, for the pair of its runs that agrees least. A candidate is held to those figures. It is measured against the answer today's runs give most often, a steadier mark than any one run, so today's own model would score a little above its own figures. Today's average lead score is 73.3. Today's model catches these known-bad drafts in every run: asks-for-phone, estate-asks-for-phone.

Agreement with today's model is what the bar asks, but it cannot tell a candidate that is wrong from one that is right where today's model is wrong. Where a visitor was written with a definite case type, the next column says how often each model named it; the turn-by-turn differences are set out further down.

A usable answer is counted each time one was due: the grade of a draft, a lead score, a case card, and every answer that had to be JSON. A call that was refused or never answered is counted apart, in its own column, with what it failed on: such a call is made again, and it may be the account that was refused and not the model.

### Each small job's time

| Run | Model | Job | Calls answered | Calls that failed | Middle | Slowest tenth | Answers that were JSON |
|---|---|---|---|---|---|---|---|
| small-base-1 | gpt-4o-mini | classify | 24 | 0 | 1.1s | 1.3s | 100% |
| small-base-1 | gpt-4o-mini | leadScore | 24 | 0 | 1.8s | 2.3s | 100% |
| small-base-1 | gpt-4o-mini | caseCard | 18 | 0 | 2.1s | 2.8s | 100% |
| small-base-1 | gpt-4o-mini | grade | 35 | 0 | 4.5s | 7.5s | 100% |
| small-base-2 | gpt-4o-mini | classify | 24 | 0 | 1.1s | 1.3s | 100% |
| small-base-2 | gpt-4o-mini | leadScore | 24 | 0 | 1.7s | 2.2s | 100% |
| small-base-2 | gpt-4o-mini | caseCard | 18 | 0 | 2.2s | 2.6s | 100% |
| small-base-2 | gpt-4o-mini | grade | 36 | 0 | 4.2s | 5.6s | 100% |
| small-base-3 | gpt-4o-mini | classify | 24 | 0 | 1.1s | 1.3s | 100% |
| small-base-3 | gpt-4o-mini | leadScore | 24 | 0 | 1.8s | 2.2s | 100% |
| small-base-3 | gpt-4o-mini | caseCard | 18 | 0 | 2.2s | 2.8s | 100% |
| small-base-3 | gpt-4o-mini | grade | 36 | 0 | 4.4s | 5.7s | 100% |
| small-gpt-6-luna | gpt-6-luna | classify | 24 | 0 | 1.4s | 2.5s | 100% |
| small-gpt-6-luna | gpt-6-luna | leadScore | 24 | 0 | 3.1s | 4.5s | 100% |
| small-gpt-6-luna | gpt-6-luna | caseCard | 18 | 0 | 3.9s | 4.8s | 100% |
| small-gpt-6-luna | gpt-6-luna | grade | 44 | 0 | 4.1s | 6.4s | 100% |
| small-gpt-5.4-mini | gpt-5.4-mini | classify | 24 | 0 | 0.9s | 1.2s | 100% |
| small-gpt-5.4-mini | gpt-5.4-mini | leadScore | 24 | 0 | 2.1s | 2.7s | 100% |
| small-gpt-5.4-mini | gpt-5.4-mini | caseCard | 18 | 0 | 2.4s | 3.0s | 100% |
| small-gpt-5.4-mini | gpt-5.4-mini | grade | 43 | 0 | 2.6s | 3.0s | 100% |
| small-gpt-5.4-nano | gpt-5.4-nano | classify | 24 | 0 | 0.9s | 1.3s | 95.8% |
| small-gpt-5.4-nano | gpt-5.4-nano | leadScore | 24 | 0 | 2.4s | 3.3s | 100% |
| small-gpt-5.4-nano | gpt-5.4-nano | caseCard | 18 | 0 | 2.5s | 3.3s | 100% |
| small-gpt-5.4-nano | gpt-5.4-nano | grade | 44 | 0 | 4.1s | 5.3s | 100% |
| small-gpt-6.1-terra | gpt-6.1-terra | classify | 24 | 0 | 1.4s | 2.2s | 100% |
| small-gpt-6.1-terra | gpt-6.1-terra | leadScore | 24 | 0 | 3.1s | 3.7s | 100% |
| small-gpt-6.1-terra | gpt-6.1-terra | caseCard | 18 | 0 | 3.9s | 4.7s | 100% |
| small-gpt-6.1-terra | gpt-6.1-terra | grade | 44 | 0 | 4.5s | 5.3s | 100% |

### The drafts that are wrong on purpose

| Draft | The rule it breaks | gpt-4o-mini (small-base-1) | gpt-4o-mini (small-base-2) | gpt-4o-mini (small-base-3) | gpt-6-luna (small-gpt-6-luna) | gpt-5.4-mini (small-gpt-5.4-mini) | gpt-5.4-nano (small-gpt-5.4-nano) | gpt-6.1-terra (small-gpt-6.1-terra) |
|---|---|---|---|---|---|---|---|---|
| asks-for-phone | PROH-MM-03 | caught | caught | caught | caught | caught | caught | caught |
| no-law-named | REQ-MM-02 | NOT caught | caught under PROH-MM-02 | caught under PROH-MM-02 | caught | caught | caught | caught |
| still-asking-at-three | REQ-MM-01 | NOT caught | NOT caught | NOT caught | caught | caught | caught | caught |
| estate-asks-for-phone | PROH-MME-03 | caught | caught | caught | caught | caught | caught | caught |
| estate-no-law-named | REQ-MME-02 | NOT caught | NOT caught | NOT caught | caught | caught | caught | caught |
| estate-still-asking-at-three | REQ-MME-01 | NOT caught | NOT caught | NOT caught | caught | caught | caught | caught |

## What passes

### For the reply

Every rule passed, cheapest first (a tie goes to the faster):

1. `gpt-6-luna` (reply-gpt-6-luna): $0.002 a conversation, slowest tenth 6.6s
2. `gpt-6.1-terra` (reply-gpt-6.1-terra): $0.019 a conversation, slowest tenth 6.6s
3. `gpt-5.4-mini` (reply-gpt-5.4-mini): $0.022 a conversation, slowest tenth 4.8s

These did not pass:

- `gpt-6.2-sol` (reply-gpt-6.2-sol): 3 turns did not pass after the rewrite, more than in today's worst run (2)
- `gpt-5.4` (reply-gpt-5.4): the slowest tenth of its replies takes 11.8s, over the 10.0s allowed

### For the small jobs

No small-job candidate passes every rule.

These did not pass:

- `gpt-6-luna` (small-gpt-6-luna): gives the same case type as today's on 79.2%, under today's own 91.7%; gives the same first verdict as today's on 70.8%, under today's own 91.7%; the slowest tenth of its grade calls takes 6.4s, over the 4.0s allowed (today's model misses this rule too)
- `gpt-5.4-mini` (small-gpt-5.4-mini): gives the same case type as today's on 83.3%, under today's own 91.7%; gives the same first verdict as today's on 66.7%, under today's own 91.7%; moves the average lead score by 8.0 points, more than 3
- `gpt-5.4-nano` (small-gpt-5.4-nano): gives a usable answer on 99.4% of the times one was due, not every time; gives the same case type as today's on 87.5%, under today's own 91.7%; gives the same first verdict as today's on 70.8%, under today's own 91.7%; moves the average lead score by 4.0 points, more than 3; the slowest tenth of its grade calls takes 5.3s, over the 4.0s allowed (today's model misses this rule too)
- `gpt-6.1-terra` (small-gpt-6.1-terra): gives the same case type as today's on 70.8%, under today's own 91.7%; gives the same first verdict as today's on 62.5%, under today's own 91.7%; moves the average lead score by 3.3 points, more than 3; the slowest tenth of its grade calls takes 5.3s, over the 4.0s allowed (today's model misses this rule too)

Today's own models, set beside the same rules:

- `gpt-4o-mini` (small-base-1): the slowest tenth of its grade calls takes 7.5s, over the 4.0s allowed
- `gpt-4o-mini` (small-base-2): the slowest tenth of its grade calls takes 5.6s, over the 4.0s allowed
- `gpt-4o-mini` (small-base-3): the slowest tenth of its grade calls takes 5.7s, over the 4.0s allowed

## What a conversation costs

|  | Reply model | Small-job model | Replies | Small jobs | Together |
|---|---|---|---|---|---|
| Today | gpt-4o | gpt-4o-mini | $0.039 | $0.005 | $0.044 |
| reply-gpt-6.2-sol (did not pass) | gpt-6.2-sol | today's | $0.043 | $0.005 | $0.048 |
| reply-gpt-6.1-terra | gpt-6.1-terra | today's | $0.019 | $0.005 | $0.024 |
| reply-gpt-6-luna | gpt-6-luna | today's | $0.002 | $0.005 | $0.007 |
| reply-gpt-5.4 (did not pass) | gpt-5.4 | today's | $0.072 | $0.005 | $0.077 |
| reply-gpt-5.4-mini | gpt-5.4-mini | today's | $0.022 | $0.005 | $0.027 |
| small-gpt-6-luna (did not pass) | today's | gpt-6-luna | $0.039 | $0.005 | $0.044 |
| small-gpt-5.4-mini (did not pass) | today's | gpt-5.4-mini | $0.039 | $0.037 | $0.077 |
| small-gpt-5.4-nano (did not pass) | today's | gpt-5.4-nano | $0.039 | $0.012 | $0.052 |
| small-gpt-6.1-terra (did not pass) | today's | gpt-6.1-terra | $0.039 | $0.039 | $0.078 |

At OpenAI's published standard prices. Input that OpenAI has cached is billed lower, so a real conversation costs a little under these figures.

## Where a small-job candidate differs from today's usual answer

**`gpt-6-luna` (small-gpt-6-luna)**

- er-stroke, turn 2: lead tier hot, where today's says warm; first verdict blocked (REQ-MM-01), where today's says passed
- er-stroke, turn 4: lead tier hot, where today's says warm
- sepsis-discharge, turn 3: first verdict blocked (REQ-MME-01), where today's says passed
- retained-guidewire, turn 2: lead tier cold, where today's says warm
- retained-guidewire, turn 4: lead tier warm, where today's says hot
- too-late, turn 2: first verdict blocked (REQ-MM-01, PROH-MM-02), where today's says passed
- too-late, turn 4: lead tier cold, where today's says none
- marisol-sponge, turn 1: case type other, where today's says hospital_negligence
- marisol-sponge, turn 2: first verdict blocked (REQ-MM-01, PROH-MM-02), where today's says passed
- marisol-sponge, turn 3: first verdict blocked (REQ-MM-01, REQ-MM-02), where today's says passed
- marisol-sponge, turn 4: first verdict passed, where today's says blocked
- pressure-ulcers, turn 1: case type nursing_home, where today's says hospital_negligence
- pressure-ulcers, turn 2: case type nursing_home, where today's says hospital_negligence; first verdict blocked (REQ-MME-01), where today's says passed
- pressure-ulcers, turn 3: case type nursing_home, where today's says hospital_negligence; lead tier hot, where today's says warm
- pressure-ulcers, turn 4: case type nursing_home, where today's says hospital_negligence; lead tier hot, where today's says warm

**`gpt-5.4-mini` (small-gpt-5.4-mini)**

- er-stroke, turn 2: lead tier premium, where today's says warm; first verdict blocked (REQ-MM-01), where today's says passed
- er-stroke, turn 3: lead tier premium, where today's says hot
- er-stroke, turn 4: lead tier premium, where today's says warm
- sepsis-discharge, turn 2: lead tier hot, where today's says warm
- sepsis-discharge, turn 3: lead tier hot, where today's says warm
- sepsis-discharge, turn 4: lead tier hot, where today's says warm
- retained-guidewire, turn 1: first verdict blocked (REQ-MM-01), where today's says passed
- retained-guidewire, turn 3: lead tier hot, where today's says warm
- too-late, turn 2: first verdict blocked (REQ-MM-01, PROH-MM-02), where today's says passed
- marisol-sponge, turn 2: lead tier hot, where today's says warm; first verdict blocked (REQ-MM-01, PROH-MM-02), where today's says passed
- marisol-sponge, turn 3: first verdict blocked (REQ-MM-02), where today's says passed
- marisol-sponge, turn 4: first verdict passed, where today's says blocked
- pressure-ulcers, turn 1: case type nursing_home, where today's says hospital_negligence
- pressure-ulcers, turn 2: case type nursing_home, where today's says hospital_negligence; first verdict blocked (REQ-MME-01), where today's says passed
- pressure-ulcers, turn 3: case type nursing_home, where today's says hospital_negligence; lead tier hot, where today's says warm
- pressure-ulcers, turn 4: case type nursing_home, where today's says hospital_negligence; lead tier hot, where today's says warm; first verdict passed, where today's says blocked

**`gpt-5.4-nano` (small-gpt-5.4-nano)**

- er-stroke, turn 2: lead tier hot, where today's says warm; first verdict blocked (REQ-MM-01), where today's says passed
- er-stroke, turn 3: first verdict blocked (REQ-MM-01), where today's says passed
- er-stroke, turn 4: lead tier hot, where today's says warm
- sepsis-discharge, turn 1: case type hospital_negligence, where today's says misdiagnosis
- sepsis-discharge, turn 2: case type hospital_negligence, where today's says misdiagnosis; lead tier hot, where today's says warm
- sepsis-discharge, turn 3: case type other, where today's says misdiagnosis; lead tier hot, where today's says warm
- sepsis-discharge, turn 4: lead tier hot, where today's says warm
- retained-guidewire, turn 2: lead tier premium, where today's says warm
- retained-guidewire, turn 3: first verdict blocked (REQ-MM-01), where today's says passed
- too-late, turn 2: first verdict blocked (REQ-MM-01, PROH-MM-02), where today's says passed
- marisol-sponge, turn 2: lead tier hot, where today's says warm; first verdict blocked (REQ-MM-01, PROH-MM-02), where today's says passed
- marisol-sponge, turn 3: first verdict blocked (REQ-MM-02), where today's says passed
- marisol-sponge, turn 4: first verdict passed, where today's says blocked
- pressure-ulcers, turn 2: lead tier warm, where today's says hot

**`gpt-6.1-terra` (small-gpt-6.1-terra)**

- er-stroke, turn 1: first verdict blocked (REQ-MM-01), where today's says passed
- er-stroke, turn 2: lead tier hot, where today's says warm; first verdict blocked (REQ-MM-01), where today's says passed
- er-stroke, turn 4: lead tier hot, where today's says warm
- sepsis-discharge, turn 1: case type hospital_negligence, where today's says misdiagnosis
- sepsis-discharge, turn 2: lead tier hot, where today's says warm
- sepsis-discharge, turn 3: first verdict blocked (REQ-MME-01), where today's says passed
- sepsis-discharge, turn 4: case type hospital_negligence, where today's says misdiagnosis; lead tier hot, where today's says warm
- retained-guidewire, turn 2: lead tier cold, where today's says warm
- retained-guidewire, turn 3: lead tier hot, where today's says warm
- too-late, turn 2: first verdict blocked (REQ-MM-01, PROH-MM-02), where today's says passed
- marisol-sponge, turn 1: case type other, where today's says hospital_negligence
- marisol-sponge, turn 2: lead tier hot, where today's says warm; first verdict blocked (REQ-MM-01, PROH-MM-02), where today's says passed
- marisol-sponge, turn 3: first verdict blocked (REQ-MM-01, REQ-MM-02), where today's says passed
- marisol-sponge, turn 4: first verdict passed, where today's says blocked
- pressure-ulcers, turn 1: case type nursing_home, where today's says hospital_negligence
- pressure-ulcers, turn 2: case type nursing_home, where today's says hospital_negligence; first verdict blocked (REQ-MME-01), where today's says passed
- pressure-ulcers, turn 3: case type nursing_home, where today's says hospital_negligence
- pressure-ulcers, turn 4: case type nursing_home, where today's says hospital_negligence; lead tier hot, where today's says warm; first verdict passed, where today's says blocked

## Cheap first, stronger on a block

For information only. A cheaper model would write the first draft, and the model below would write only when the gate blocked that draft. Whether the replies would then pass was not measured.

`gpt-6-luna`, the cheapest candidate that passes, is also the cheapest measured: there is nothing cheaper to put in front of it.

## Notes

- All eight models were asked on 20 November 2026 whether OpenAI lists them and whether they take the app's three kinds of request: every one did.
- OpenAI shuts down the snapshots behind gpt-4o, gpt-4o-mini, gpt-4.1 and gpt-4.1-mini on 14 January 2027.
- gpt-5.4-nano is deprecated: OpenAI shuts it down on 1 April 2027 and names gpt-6-luna as its replacement.
- gpt-6.1-terra was also measured as a small-job model, beyond the candidates the design names, because none of those passed.
- Two further runs were stopped part-way when the machine ran out of memory, and are not in this report: gpt-6.2-sol as a small-job model, and gpt-6-luna as the reply model graded by gpt-6-luna. Each can be carried on from where it stopped.
- Times are of single calls made from one machine on one day. They show which model is quicker, not what a visitor will always wait.
- The gate did not look citations up on CourtListener in these runs, so a case counts as anchored only when it is among the decisions the reply was given.
