# Three effects at play size

These are original pitches for a paper or screen prototype. The numbers describe proposed rules. Adjust them to the game's movement, camera and audience.

## Margin Fold

In a race across a paper sky, rivals carry little foil stars back to a star chart. A player can fold a strip of sky over itself and shake a star loose. Spending a fold on the leader at the chart feels different from saving it for a crowded lane. A rival with empty hands can run straight across.

**One round.** Each player gets two folds. Aim at three contiguous floor cells in a straight line, all visible and on the board, with the middle cell within four grid steps. The caster may rotate or cancel the private preview freely. An invalid release leaves both folds available. On a valid release, spend one fold, fix all three cells in place, and show them to everyone. After 0.60 seconds, each rival standing on one of those cells loses one carried star back to the supply for the round. Banked stars and the caster are safe. Resolve movement for that instant first. Simultaneous folds remove at most one star per rival on that instant. A later fold is a new decision. Once the line appears to rivals, the caster cannot move it or take it back.

| Moment | Shape on screen | Where to look |
| --- | --- | --- |
| Aim | Three hollow cells under the caster's cursor. An invalid group has a crossed corner. | The prospective strip and the route to bank. |
| Commitment to 0.60 s | A dark crease appears along one long edge. Turned-up corners at the other edge join the three cells into one footprint. The corners rise while the footprint stays fixed. | A rival can see which edge to cross. The crease should survive bright and shadowed paper. |
| At 0.60 s | Remove the footprint when the game checks occupancy. On each actual loss, one foil star lifts straight out of its carrier's pouch. | The eye moves from floor to pouch. An empty lane gets a dry flip with no star. |
| Next 0.20 s | A loose paper shaving tumbles down from the crease. | The shaving can cross a cell edge because the spent scrap is small and detached. Another live crease keeps its outline. |

A gold wash across the whole page would sell the preciousness of the stars and hide the information that matters most to a runner. Put the metallic accent inside each lost star. Against two crossing folds, keep both outer footprints intact and share a quieter fill at the intersection. A tiny crown or player mark on the crease can carry ownership when colors coincide. A reduced-motion version holds the cells still, adds corner bars in two steps, then changes the pouch count.

Start with three rectangles and a pouch icon. Try entering and leaving the strip on the resolving step, two folds crossing over one carrier, and a carrier who has already banked everything. Then give someone one unfamiliar layout at play size. Observe which edge they cross and whether they cross before the fold. If they understand the edge and choose the shortest exit but cannot cover that distance with the game's movement speed, change the footprint or warning window. Making the paper brighter cannot supply a missing movement step.

## Pocket Chorus

“I want a spell for the organist in a two-person observatory.” They could steal a distant note to hear what lies behind a wall, or lend a key their voice and walk away while it continues to sound. The second idea leaves the organist free to turn a telescope. Their partner can continue playing ordinary notes.

Give the organist one empty porcelain bird. Hold down an organ key and perch the bird on it. On release of the placement button, if the key is still depressed, visible and within arm's reach, the bird latches that note for six seconds. It can hold one key. A key already occupied by a bird refuses a second one. A lost target, cancelled placement or refused key leaves the bird available. Placing it costs the opportunity to sustain any other key until it returns. Touching the perched bird recalls it early. A held key sounds while **either** a hand or a perched bird holds it. On expiry or recall, return the bird and release only its contribution. A partner can keep playing through the handover.

Keep the keys broad at duet distance. During placement, a light ceramic profile hovers above the selected key with daylight between the feet and the wood. On commitment, the feet close around the key, the body settles, and the ordinary key-down pose stays visible beneath it. In the last two seconds, two dark feathers on the bird's breast fold in, one at a time. On release it opens its feet. If a hand still holds the key, the key stays down. The ordinary pressed-key pose and an engraved note mark communicate sustain with the sound muted. With reduced motion, swap between the perched, one-feather and empty perches.

A glowing staff that fills the screen whenever someone plays would drown out the partner's own notes. Give the bird one short ceramic click at attachment and let the music itself carry the long, quiet middle. A ribbon from caster to key would imply the spell breaks when the organist walks away. Try the first version with just the perched bird and two key poses. Ask the partner to take over near expiry. Watch whether they hold the correct key and whether the organist feels free to walk to the telescope. Counting how long the note sounds will catch an expiry bug. It takes those two human choices to learn whether the duet reads.

## The ferry behind the houses

In a slow port-town game, the afternoon ferry passes out of sight. The player is peeling an orange in a yard. The dockside clothesline lifts, then the line close to the table stirs. An empty sleeve descends more slowly than the pegged towel beside it. For a moment the player can feel the harbor nearby without leaving the yard. The ferry has no boarding prompt or task here.

Trigger one wave on the ferry's passage. Anchor each cloth at its pegs. Lift the dockside hem first, pass the bend along it, and leave a brief quiet gap before the nearer line answers. Let the sleeve make a small second swing as the towel goes still. Keep the orange and the hands the warmest compact shape. At their edges, preserve enough empty space for the peel to read against the table. In a distant room a single offset silhouette can carry the passing gust. Close to the yard, two cutout poses per towel and a third for the sleeve may be enough. Wind from the ferry need not send a hundred translucent motes through the kitchen.

An evenly repeating ripple on both lines suggests a machine or a steady breeze. A bright pulse on every peg suggests a collectible. Compare the two lines moving together with the delayed response, using the same poses and total sweep. Let the player finish peeling before asking what they noticed. “Something big went by” supports this direction. A pleasant breeze with no hint of its source can also fit a creator who only wants a lived-in yard. If players abandon the orange to collect the pegs, reduce the synchronized accents and try again. In reduced motion, leave the distant line in a new resting pose for the beat and use the low ferry horn or an optional environmental caption for players who want the cue.

## Diagnose a supplied timeline

Suppose a creator supplies these stamped frames of Margin Fold. At 0.00, an aimed strip appears on the caster's screen. At 0.40, both rival-view outer corners are still hidden under the rival's cape. At 0.52, the far corner clears the cape. At 0.60, the pouch loses a star. The observed gap from the first shown clear corner to the result is 0.08 seconds. These samples leave the frames between them open. Inspect the intervening rival-view frames before calling 0.52 the first actionable cue. The input event and game-state log would establish the actual commitment and loss times.

Keep the crease and the foil-star response. Test one change first. Draw the far corners above the floor decoration and outside the cape silhouette while preserving their world positions. Compare first-time runs on matched layouts. If runners choose the correct cell earlier, the old layering mattered. If they describe the right escape and still arrive late, measure travel from a central cell to a safe one during the available time. If the footprint arrives late only on the rival's screen, compare commit and first-visible timestamps for the two views before editing the art.

For a cheap load check, repeat the same camera path with one fold, then the maximum overlapping casts the round permits. Compare the busiest frame times against the game's target on its intended device. Turn off the transparent fills while keeping the exact footprints and loss events. If frame time improves as the large fills disappear, spend less screen area on them. If the footprints become hard to separate even at steady frame time, try the shared fill and distinct edges. Those are two different observations from the same scene.
