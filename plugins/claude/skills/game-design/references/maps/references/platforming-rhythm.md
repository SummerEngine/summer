# Design a platforming room around player actions

Write an intended trip as a short sequence before drawing platforms. Record where the player starts a run, jumps, lands, stops, changes direction or waits. Draw the takeoff and recovery surfaces for those actions at the controller's measured speeds. For every gap, mark what the camera shows before a player can still choose to jump. For every miss, draw where the player ends up and what they can do there.

## Prototype the tide-clock workshop

A repairer carries a brass weight across two broken boards. Beyond them is a stone sill beside a passing carriage. The sill gives the repairer a safe place to stop and wait for the next pass. The trip on paper is a pair of short jumps, a safe landing, a look at the track and a boarding jump. Keep a successful running approach available.

Make the sill long enough to stop after the second jump at the fastest plausible entry speed. Time a full carriage cycle, including the first interval when the carriage can be seen from a stationary position. Run these checks from the actual camera and with the intended input. A side drawing can show the landing while the running camera still hides it.

For layout A, hang a pickup above the far end of the sill so collecting it takes an extra jump. For B, place the pickup at the same horizontal position within standing reach. Start first-time visitors at the same carriage phase and give one layout to each. Keep the geometry, camera and motion fixed for that comparison.

| Result | Next check |
| --- | --- |
| In A, players jump toward the pickup and miss the carriage. In B, players collect and pause. | Ask what they aimed for. If the pickup drove the extra jump, keep the reachable placement. |
| Players in both layouts try to brake and slide off. | Replay from the recorded approach speed. If there is too little stopping distance, lengthen the sill and repeat. |
| Players stop, then miss the carriage because they see it too late. | Reveal the track sooner from the sill. Measure the change in time available to jump. |
| A player boards at speed and can point to the place they could have stopped. | Count the fast trip as success. Keep the pause available for someone who wants it. |

Record first attempts and retries separately. Note approach speed, takeoff and landing, collection, the carriage's position and whether a miss gives the player another chance to understand the route. A fall at the same spot can follow several different decisions.

## Draw a second rhythm

Keep the entry and exit positions fixed. Try swapping the second break for a short rise that still requires a jump. The original break can drop a missed player onto a lower return path. The rise can leave a missed player on safe ground for an immediate retry. The intended input order stays familiar while the stakes change. If a jump ever becomes compulsory, walk its return path and revisit it after a missed attempt. Make sure the player can reach the next stable surface from every allowed start.

For a set of generated variants, compare measurable properties such as consecutive required jumps and visible time to board from the sill. Count accepted patterns and track rejected ones with their rejection reason. Walk at least one ordinary layout and one rare layout at a given setting. Then change a single design control and repeat with the same starting conditions. If two rooms score the same and ask the player for different decisions, record the route or cue that the measure missed.
