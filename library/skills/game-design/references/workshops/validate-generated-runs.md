# Validate generated runs

Write the decisions a generated run should offer and the guarantees it must uphold. Mark which content is mandatory, optional or decorative. Record seed, generator version, settings and starting state with each case. A saved layout can help when an edit or a version change prevents the generator from recreating an old seed.

## Build and break a floodgate route

Make a paper or greybox layout for a courier who must drain a canal and deliver a parcel. The courier starts without a boat. The drain control needs a crank, and the exit requires the parcel. A floating overlook is optional.

1. Sketch a mission graph for start, crank, drain, parcel and exit. Write the conditions and effects for each action. Make three spatial layouts that realise this graph in different ways. Record whether the graph or spatial placement produced each connector.
2. Replay from the real start conditions. Use the actual avatar clearance, movement range and resource budget. Look for every mandatory transition, including leaving a room after taking the crank. Give the generator a validation budget and define a safe fallback for cases it cannot repair.
3. Create a deliberate failure. Put the crank where it can be reached only after draining the canal. Then make the graph valid and narrow one connector until the avatar cannot use it. Reproduce both failures. Repair the earliest incorrect assumption and rerun the saved cases.
4. Test for a successful route that skips the drain. Try moving and jumping with the starting equipment or carrying a movable crate from the dry side. A valid route proves reachability. Requiring the drain mechanic also requires checking for successful bypasses. Use a solver when the rules can be represented faithfully, and check candidate routes with real movement where needed.
5. Give players an unfamiliar layout where draining a flooded space matters again. Watch when they recognise the opportunity and how they choose to act. Keep satisfying shortcuts on optional routes when discovering them serves the game.

## Choose an encoding and an evaluator

Make a second generator for the same test goal. For instance, connect known rooms before placing obstacles, or place rooms with a spatial rule and then search for viable connectors. A grid can change one tile at a time. A room graph can move a whole branch at once. Compare how each edit affects constraints and how often repair changes the intended choice.

For a route, require enough clearance and a guaranteed exit. Rank valid layouts on competing aims such as number of usable choices and length of open stretches. For terrain, requiring an uninterrupted vehicle route can favour flat ground. Measure slopes and obstacles where you want decisions about traction or detours. For generated rules, screen for legal turns, first-move advantage, stalled games and runs that end before anyone makes a tradeoff. Try hand play on outliers even when they score well.

Collect a repeatable seed set and a fresh one. Draw a small distribution of outcomes, including invalid, repaired and fallback cases. Compare layout statistics with the decisions players actually make. If five layouts ask players to pay the same cost at the first fork, change one branch in a single seed to test a genuine alternative. Ask where players would go and why before revealing either branch. If the choices already differ, investigate whether landmarks make the runs recognisable. Fixed patterns can suit deliberate practice.

## Test when the rules depend on people

| Situation | One comparison | Evidence to keep |
|---|---|---|
| A generated alliance collapses for an apparently arbitrary reason. | Trace preconditions and effects from the refusal to the first relevant event. Replay with one observable clue to the connection. | Ask players to predict a similar reaction. If they can explain both cases but still object, inspect what the character stood to gain and what the reaction cost them. A mystery can delay the clue until the reveal. |
| An adaptation interprets pauses or retries as frustration. | Freeze the adjustment for one comparable segment. Give players both versions, alternate order and keep the task fixed. | Compare preferences, explanations and performance. If the faster version is less welcome, revise what the adaptation tries to optimise. Check whether the player can keep a preferred setting. |
| Creators keep undoing a generated pacing change. | Pin a valued bridge. Ask for a compatible local edit and then one that would require moving it. | Inspect which geometry and rules changed, whether the pin survived, whether conflicts were explained and whether undo restores the draft. A deliberate whole-run reroll has a different promise. |

Keep the smallest failing seed, the checked rule, the repair and one new case that exercises the same rule. List which guarantees depend on simulation or play and which can be checked from structure.
