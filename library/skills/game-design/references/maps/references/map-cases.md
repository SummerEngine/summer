# Four map design cases

These are original paper designs. Distances and speeds are provisional. None of the examples reports human playtest results.

## A mail route around the tide pool

**Creator brief.** A short third-person delivery game in a seaside town. The harbor should feel like somewhere the player can learn to live. The first assignment is to collect a stamp from the bakery, deliver a parcel to the beacon keeper and walk back to the post office.

**First drawing.** Put the post office on the inland side of a market arch. Frame the beacon's forked roof in the arch so the keeper's house is visible before the player can visit it. Place the bakery at the fork. Beyond it give the player a choice between a hill with a view into the keeper's greenhouse, and a quay with a view of a tide pool at street level. After accepting the stamped parcel, the keeper lowers a private footbridge across the pool. The new return crosses the place the player previously walked around.

```text
                   Hill steps
                  /          \
Post office — Bakery          Beacon house
                  \          /
                   Quay ramp

Beacon house — footbridge across the pool — Post office
               opens on confirmed delivery
```

All solid links allow travel in both directions once open. Proposed walking distances are 12 m from the post office to the bakery, 10 m plus 14 m by the hill, and 16 m plus 16 m by the quay. The open footbridge is 15 m. At an assumed 3 m/s, with no pauses, the stamped outbound journey takes 12 s by the hill or about 15 s by the quay. Returning by the bridge takes 5 s. In the initial state the player can walk to the beacon with an unstamped parcel. The keeper identifies the bakery and accepts the parcel only after the player returns with the stamp. This makes the delivery order consistent with either traversal order.

**What to prototype.** Make the arch, fork, bridge and roof from simple shapes. Give the lighthouse a different outline from the two market stalls. Put a fish-shaped relief at the quay entrance. If the game offers an exit query, have it name this branch “Quay ramp” from either approach so a player can identify the turn without seeing the relief. On the return trip let players see the market arch from the water side. A distinctive roof identifies the destination. Its position across the water tells players where they are, while the fork still asks how they want to travel.

**A different layout.** A beacon above a switchback street would reveal the town a little at a time as the player climbs. Pick the harbor loop first for this brief because the opening and return views tie the same destinations together. Pick the switchback if the creator wants the final reveal of the town to be the reward.

**What would change the plan.** In a first-visit test, have each player choose a route before giving directions. If they recognize both options but express a consistent preference, find out what they liked before redesigning the less-used one. If they see the beacon but cannot distinguish the quay entrance from a shop door, change the threshold and keep the roof. For the return, ask for the post office after they have crossed the footbridge. Repeating the outbound directions would miss the reversed view.

## A platforming room for a tired clockmaker

**Creator brief.** Two-dimensional side view. Bring a dropped minute hand back to the bench. The jump should invite a satisfying shortcut while a first-time player can finish via a gentler route.

Assume a 0.6 m-wide character and an equal-height running jump that travels 2.4 m between center positions in the test controller. Draw the bench on the left platform and the minute hand on the right. Leave a 1.5 m lip-to-lip gap. A jump beginning with the center 0.3 m inside the left lip and landing 0.3 m inside the right lip requires 2.1 m of horizontal travel. That leaves 0.3 m of measured margin under the assumed run. The figure says nothing about acceleration from rest, early releases, the width of the landing as seen on screen, or how many players will attempt it.

Provide stairs down from each ledge to a lower gallery which also catches a miss. A floor route now connects both sides without jumping. The lower gallery passes through the exposed clockworks, so a cautious player gets a scene the faster route skips. On the way home the player can choose again. Put a notch in each lip so both are visible against the moving background. Leave enough room after each stair exit for the character to accelerate before the next jump.

**First test.** Keep movement, geometry and retry cost fixed. Compare a camera that reveals the receiving ledge while there is still room to start a run with the original framing. Watch approach, takeoff, landing and route after a miss. If players predict the landing but repeatedly fall short, measure the actual start speed and landing collision. If the return jump alone causes trouble, inspect the camera when facing left. To extend the sequence, use the [platforming rhythm workshop](platforming-rhythm.md).

## A station map that mistakes a crossing for a connection

**Reported issue.** In a two-floor station, a player can point at the platform on the large map but keeps walking to the gallery above it. Start by marking what the report establishes. The destination was recognized. The player may have read an overlapping route as an interchange, missed a lift entrance, or found the lift unusable.

**Walk this plan.** Lower floor links run from Ticket Hall to Lift L and from Ticket Hall to East Stairs. Upper floor links run from Lift L to Platform and from East Stairs to Gallery. A window at Gallery looks down into the Ticket Hall. Railings between Gallery and Platform leave no walkable connection there. The only step-free trip to Platform is Ticket Hall → Lift L, go up → Platform. A player on the Gallery can recover by descending the East Stairs and returning to Lift L.

**Map revision.** Give the map two named floors. Put the same L-in-a-square symbol and lift name at both endpoints. Label the exit from the upper lift “Platform.” Keep the track outline light at station zoom and show the gallery railing at floor zoom. An identical red and green pair of circles would ask players to remember both a color and a floor. Offer a direction list using the same exit names and a way to review the last direction. This lets the map communicate a turn sequence without requiring a player to distinguish color or rotate a mental image.

**Compare at the decision point.** From Ticket Hall, ask an unfamiliar player to reach Platform by a step-free route. Record the first transition they select and where in the journey they open the map again. Selecting the wrong transition before moving implicates the representation. Selecting Lift L on the map and walking past it points toward its world cue. Reaching the lift and being unable to call it points toward interaction or access. Ask for the same journey under the representation the player uses, including a spoken or text route where available. Preserve the optional view from Gallery. The issue is the perceived interchange, and the lookout still gives the station character.

## An archipelago that can be explored in two orders

**Creator brief.** Sail to a kite festival in the clouds. Players should be able to choose which island to visit first and feel like local navigators by the time they reach the festival. Scope the first draft to four islands and one new sailing action.

| Place | What a visit changes | Connections at the start |
| --- | --- | --- |
| Anchorage | The player sees the festival kites over a distant ridge and learns how to request a tow if lost. | Ordinary sailing to Reedbank and Kiln Isle. |
| Reedbank | A sailmaker fits a reefing line. The player can now ride gusts. | Ordinary sailing to Anchorage and Kiln Isle. A gust leads directly to the festival. |
| Kiln Isle | A potter describes a sea arch shaped like a cup handle. Knowing that mark lets a player recognize the ordinary passage. | Ordinary sailing to Anchorage and Reedbank. A narrow, always navigable passage leads to the festival. |
| Festival | Arrival completes the commission. Both island services remain available after arrival. | The narrow passage returns to Kiln Isle. A tow can return the player to Anchorage. |

There are two different kinds of progress. The line changes what the boat can do. The potter changes what the player knows. Keep the ordinary passage open at the start so a player who recognizes the arch early can make a real discovery. If the creator wants both island stories to be compulsory, this layout would allow an early finish. Change the commission or the connections, or retain the early finish as the intended reward for reading the world.

**Prototype the scale.** Make the direct sailing legs index cards with provisional travel times. Put the first sight of the gust and the first sight of the cup handle on separate cards for each approach. Compress a long leg when it only postpones the same decision. Retain enough time to notice the arch and turn toward it if its silhouette is the clue. The world chart can name islands after discovery and draw confirmed routes separately from a player's own “possible passage” pin. A spoken place description can give the same cup-handle clue without explicitly identifying the secret passage.

**Try three histories.** Visit only Reedbank and reach the festival through the gust. Visit only Kiln Isle and use the ordinary passage. Sail past the potter and enter the passage without learning the name. Check the world chart, arrival dialogue and return option in each history. A dialogue line thanking the player for visiting both villagers would be incorrect for all three. If the graph works but fresh players sail past the arch even after hearing the clue, inspect viewing distance and the silhouette on their actual approach before adding a quest gate.
