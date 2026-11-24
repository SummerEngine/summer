# Strategy and tactics

Use the creator's promise and the evidence already available. If called during an interview, continue from their latest answer with one relevant question and wait for their reply. For a genre-specific experiment, use the [matching design cases](../strategy.md). Keep creator replies free of book citations and reading lists.

## Draft one strategic choice

Use this when the creator wants to invent a choice or give a player a reason to reconsider an automatic move. If there are no rules yet, sketch one turn with an obvious action, what it pays, and when the player takes it. Write the desired trade in terms of visible game states, such as “take the larger reward when time is cheap, spend the turn elsewhere when the opportunity is valuable.” Keep the actions and components from the sketch or current rules. Choose one relation you can replace, such as which action requires preparation, who owns a reward, or when a reply becomes legal. Draw each candidate as an action order with costs and prerequisites. Reject candidates that break an existing guarantee.

Give each candidate a small set of positions whose outcomes you can calculate. When the promise is to adapt to visible stakes, look for two ordinary positions in which both actions are legal and a different action serves the same goal better. Then look for a third position or a legal sequence that bypasses the new cost. Test the intended sequence and the shortcut separately before generating more candidates.

**Original paper prototype.** A festival poster game gives the player two turns, one action per turn and one unprepared poster. The player can ship it once as Plain for 3 points or Foil for 5. They can take one side job, publicly worth either 1 or 3 points. Shipping and the side job each cost a turn, and play continues until both turns are used. The designer wants the player to choose between a higher-value finish and a worthwhile side job. The existing Prep action, used for other orders, costs one turn. Try changing the Foil payout or which finish needs Prep. Maximize total points over the two turns.

| Candidate | Side job worth 1, Plain vs. Foil | Side job worth 3, Plain vs. Foil | Structural result |
|---|---|---|---|
| Either finish ships directly | 4 vs. 6 | 6 vs. 8 | Foil always leaves time for the job and wins. |
| Drop Foil to 4 | 4 vs. 5 | 6 vs. 7 | Foil still wins. |
| Both finishes need Prep before shipping | 3 vs. 5 | 3 vs. 5 | Neither leaves time for the job. |
| Only Foil needs Prep before shipping | 4 vs. 5 | 6 vs. 5 | The preferred plan switches when the visible job value changes. |

The last candidate makes the trade possible with the same components. Challenge it with a player who already prepared the poster before the first turn. Foil can then be shipped alongside either job, scoring 6 or 8, and the switch disappears. If prior preparation took a consequential turn elsewhere, trace that earlier cost. If a common opening grants it free, reject or narrow the candidate. Hand the surviving draft to a player with the two original job cards. Ask them to pick a plan and predict their final score before resolving it. The two calculated results establish the trade under those rules. A player's unaided plan and explanation show whether the trade is legible enough to use.

## Reconstruct one decision

Start just before the player commits. Record the goal and stakes, the turn or time, what each side actually knows, each serious alternative, and what each spends or gives up. Include passing, waiting or saving a resource if the rules permit it. Follow the order of reveals, payments, responses and resolution until a relevant state changes. For a response, find the last point at which it can still work. Check its cost and prerequisites at that point. A counter available in a loadout or rulebook may be impossible to reach in the positions players normally encounter.

Pair a prediction with a branch. Ask the player what the move will change before resolving it. Replay the same position with a different move and an opposing reply that was legal with the information available then. Preserve unrelated draws and opening conditions. Reverse seats when priority or placement may matter. Write down which player or script supplied each reply. In an automated battle, change one setup choice and follow it to the first changed target, timing or resource exchange. Keep the random seed fixed if both setups can use the same draw sequence. If the first divergence never reaches the promised outcome, keep tracing to the next commitment.

### Worked position in a fictional game

In **Signal Sprint**, two rivals compare points scored over a two-turn leg. The Courier locks Bridge or Park at the start of turn 4. They know the Keeper's opening charge. The Keeper sees a route glyph before their turn 4 action. In the current interface the glyph is available without a legend. The Keeper then either Banks for +1 charge or Claims a point at no charge cost. Both actions are legal, and only one may be taken. At the start of turn 5 the Keeper gets +1 charge. They can pay 3 charge then to close Bridge before scoring. A closure makes Bridge worth 0 instead of 4 points. Park always scores 2. There is no randomness in this position.

| Courier commitment | Keeper Claims, starting charge 1 | Keeper Banks, starting charge 1 |
|---|---|---|
| Bridge | Keeper's charge reaches 2, so closure is unavailable. Leg score Courier 4, Keeper 1. | Keeper's charge reaches 3. Close Bridge for a leg score of 0 to 0. |
| Park | Claim earns a point. Leg score Courier 2, Keeper 1. | Bank earns no point. Leg score Courier 2, Keeper 0. |

If a recording shows Bridge followed by Claim and a 4–1 finish without the Keeper's charge, check the start state first. Both starting charges below can produce that score. At charge 1 the table establishes that the Keeper could prepare a closure. Use nearby positions to test whether the same symptom comes from a different constraint.

- **The glyph fails to communicate the commitment.** Keep charge and timing fixed. In matched positions with the Courier's route fixed in advance, add only a Bridge/Park label. Ask the Keeper which action leaves enough charge, then let them play. Bank on Bridge and Claim on Park, with accurate explanations, supports tuning the glyph. Give them a fresh position after the comparison to check whether the cue supports a prediction without coaching.
- **The response is unaffordable by its deadline at charge 0.** In that position, Bank gives the Keeper only 2 charge by turn 5. The displayed rule and correctly read glyph still leave Bridge worth 4. Count how often that position occurs when Bridge is actionable. If a response is meant to exist there, test closure at 2 charge. Bank would enable it and Claim would still fall short at 1. At starting charge 1 the same change lets Claim and closure coexist. Check that adjacent case before adopting a global price change.
- **The Courier's choice collapses against a reliably informed Keeper.** At starting charge 1, an informed Keeper can Bank against Bridge and Claim against Park. Park offers the Courier a positive margin in this leg, while Bridge can be held to a tie. At starting charge 0 under the original price, Bridge offers a better leg result against either Keeper action. Present both starting states to the Courier, before revealing the Keeper's plan. Switching routes for a stated reason supports keeping both routes. If almost every representative state favors Park even after checking opening charge and score stakes, tune the commitment or cut the redundant route. A dependable Park can be worth keeping as a deliberate safe fallback if Bridge changes a reachable outcome elsewhere.

A single forced branch establishes what can happen under the rules. To judge what happens in ordinary play, follow up with unscripted legs and record starting charge, predicted route, action, closure and leg scores. If the game promises deduction, test a readable clue with room for inference before making the route explicit in the shipped version.

## Place uncertainty around the commitment

Use this when players blame luck or report that a roll made their choice irrelevant. Mark whether a draw supplies options to choose among, resolves a risk the player can price before committing, or takes effect while there is still time to revise. Freeze the draw sequence and move only the reveal across the commitment for a paper comparison. Ask which action the player would switch to and what that switch gives up.

**Paper comparison in a fictional race.** A fair draw yields Clear or Fog. Before seeing it, choose Long for 6 points in Clear or 0 in Fog, or Short for 3 in either. Both average 3, but Short guarantees 3 and Long can get the 6 needed to overtake a rival. Reveal before the choice and Long in Clear plus Short in Fog averages 4.5. The earlier reveal both changes what the player can decide and raises the expected score under that policy. A higher score alone therefore supplies weak evidence about agency. Look for players switching as the draw changes and explaining why. Keep the later reveal if players already make intentional risk choices and the wager serves the promise. Tune reveal timing if players need to adapt to a drawn condition and the new timing enables that behavior. If each draw still leaves the same best legal move, change the available alternatives before changing the odds.

## Find when a lead closes the response window

When an opening looks unbeatable, record resources before and after each payment, when a purchase starts paying, who acts first, and the last time a reply can still change the result. Change one rate, price, or payout time and replay the same opening.

**Paper trace in a fictional scoring race.** Each side earns 2 tokens at the start of its turn. A starts with 5 tokens and buys a 5-token engine before round 1, so its wallet starts at 0. Each engine adds 2 per turn from the next round onward. B starts with 0. A acts first each round. The first player to claim the only scoring slot wins. The slot costs A 8 tokens and B 6, and opens in round 3.

| Round | A after income and action | B after income and action |
|---|---|---|
| 1 | 4 tokens, holds | 2 tokens, holds |
| 2 | 8, buys a second engine, 3 remain | 4 tokens, holds |
| 3 | 3 + 2 base + 4 from engines = 9, claims first | Would earn 6 at the start of its turn. A's claim ends the race. |

Delay only the second engine's first payout by one round. With the same purchases, A reaches 7 in round 3 and B can claim for 6. Now let A adapt to the new rule. Holding the 8 in round 2 leaves A with 8 + 2 base + 2 from the first engine = 12 in round 3, enough to claim first under the delay. The payout changed the result for the scripted purchases while the response remained avoidable. Reverse priority in the original rules and B claims first even if A saves, because B reaches 6 before A's turn. Compare plausible adaptations across openings before retuning. Record the last affordable reply as well as the winner. Tune a payout if it closes responses earlier than the promise allows across those adaptations. Inspect priority if the symptom follows turn order regardless of investment. Keep a fast finish when securing the lead is meant to end the contest and players had a timely answer before it.

## Price waiting and delayed consequences

When a bid, pass, setup move or campaign choice looks automatic, compare its payoff against what it preserves or removes from the next decision. Take two nearby states with the same current payoff and a different remaining horizon. Record what the player predicts before commitment, what actually changes on resolution, and which later action that change enables or prevents.

**Paper comparison in a fictional auction.** Spending the last permit takes today's lot for 4 points. Passing preserves the permit for a 7-point lot if the next draw opens an auction. If the market closes, the permit expires for 0. With 8 open and 2 close markers remaining, passing averages 5.6 points. With 4 open and 6 close, it averages 2.8. Current value and holdings are identical. Compare what a points-maximizing player does in each case, then check whether score stakes justify another preference. A player who needs at least 7 to overtake should pass in both states. Repeated passing alone supplies little evidence of a stale market. If players can explain the change after seeing only the existing deadline information more clearly, tune visibility. If the sampled deadlines always make waiting better regardless of who needs which lot, tune the opportunity or cut the automatic step.

For a campaign, find the first commitment a later cost could influence. Ask players to predict both when the cost arrives and which action incurs it. If they predict the cost and willingly pay it in some situations, preserve the trade. If they attribute the cost to a later choice, test a preview at the original commitment. Use the [winter delivery comparison](../strategy.md#winter-delivery) for a paper test.

## Check what each seat can still gain

When a three-sided competition stalls or ends in an apparent grudge move, inspect each seat's attainable outcomes. At the stalled position compare waiting with acting for each seat, including the benefit to a rival who spends nothing. At the final position list each seat's best attainable standing and which other seat can win after each legal move.

For a fictional contest at 12–10–6 with only the third seat left to act, subtracting 3 from either rival can pick the winner. Adding 3 to the third seat's own score leaves it third. If placement matters, test increasing only that personal action to +5. The third seat can now finish second at 11, while first place remains out of reach for that seat. Rotate players through the same seats and check whether choices track the attainable placement or the identity of a rival. If the game scores only the winner, this particular change offers little reason to switch. If negotiated influence is the promised payoff, verify that players value and use that influence before removing it. Early waiting requires a separate comparison at the point where each player first had a reason to act.

## Interview the creator

Choose the first unanswered branch that could change your recommendation. Ask one question and wait.

| Latest answer | Next question or immediate work |
|---|---|
| They have a premise and want to invent a choice. | “What's the obvious move a player would make on their first turn?” Use the answer to sketch the starting rule. |
| The creator describes a system or list of moves without a specific choice. | “Which position makes a player seriously consider two moves?” |
| They can name only one viable move, and want to give the player a new trade. | Use the paper draft above. After showing one candidate, ask “What existing opportunity would the player give up to take this move?” |
| They can name only one viable move in the current position. | Change one constraint in a small paper position, such as starting charge or remaining turns. Ask “Would you take the other move here?” |
| They name two moves and a counter, but supply no timing. | “What is the last moment the other player can still afford that response?” |
| They describe a timely response that players rarely use. | “What can the player see before they have to prepare it?” |
| Players understand the stakes and keep taking the same move. | “What nearby position would make the other move better for their goal?” |
| They attribute repeated losses to luck. | “If the same draw were visible one step earlier, which move could the player change?” |
| They describe a dead lead or a third seat picking the winner. | “What can the trailing player still improve for themselves on their next turn?” |
| They supply a saved position, rules excerpt or recording that answers the open question. | Inspect that evidence now. Ask about intent only if it changes the test or verdict. |

## Return the design decision

Lead with **keep, tune, cut, prototype, or test**, followed by one position with its locator and the actual prediction, action and result if observed. For a prototype, return the rule change, the positions that make each action worthwhile, and any shortcut that could undo the trade. For a tune, name the one change and a nearby position where it could remove a desirable choice. For a cut, show that the action lacks a distinct reachable job under the intended goal across the relevant states. For a keep, identify the different conditions where the alternatives earn their place. If only rules or a pitch are available, state the structural result or hypothesis and the smallest comparison that could overturn it. Distinguish a computed branch, an observed action, and the player's account of why they chose it.
