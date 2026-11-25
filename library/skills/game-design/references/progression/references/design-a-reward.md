# Design a reward and its first use

## Generate candidates from an action

At a representative decision, finish the sentence “If only I could…” from the player's point of view. Make two or three rules that answer it at different scopes. Try lowering an existing cost, adding an action with a limited use, or letting the reward remove a restriction. For each, write the state it requires and the state it creates.

Chain those effects into the requirements of the next step, beginning with what the player already has. Only then place the steps in an area or run. Check reachability after moving a reward or adding a gate.

Write one check that the reward makes the goal possible and another for the decision the reward should preserve. In the dispatch exercise below, check that both parcels can reach their depots by the deadline. Then check that changing the route board changes which parcel should use the cable.

## Paper prototype made from those steps

The player runs a dispatch station with two depots, Hill and Quay. The wish is to send a parcel ahead when one route is held up. The design goal is for the player to read the route board and reserve the new ability for one delivery. Use two parcel tokens, one cable-use token, and a tick counter.

1. **Earn.** Begin at the station without the cable badge. Walk to Hill and back with a practice parcel in 2 ticks. A completed practice delivery grants the badge at the station. The player can then try sending a sample parcel by cable outside the timed shift.
2. **Use.** Begin a timed shift at the station with the badge, one cable-use token and two addressed parcels. Show both walk times. Each action delivers one parcel and ends at the station. Walking costs the displayed round-trip time. Cable delivery costs 1 tick and uses up the token. A parcel can only be delivered once. The shift succeeds if both deliveries finish in at most 4 ticks. Retrying the shift preserves the badge, restores one token and resets deliveries and time.
3. **Adapt.** On the next shift, change which depot takes longer. Keep the deadline and reward rule fixed. Ask the player which depot they will send by cable and what that commits them to do next.

| Route board at the station | Spend the cable use on Hill | Spend the cable use on Quay |
|---|---|---|
| Hill 5 ticks, Quay 2 | Cable Hill for 1 and walk to Quay and back for 2. Succeeds in 3. | Cable Quay for 1 and walk to Hill and back for 5. Fails in 6. |
| Hill 2 ticks, Quay 5 | Cable Hill for 1 and walk to Quay and back for 5. Fails in 6. | Cable Quay for 1 and walk to Hill and back for 2. Succeeds in 3. |

Walking both takes 7 ticks in either state. A boost that shaves 1 tick from each walk still takes 5. Reject it for this deadline. An unlimited cable clears both states in 2 ticks using the same plan. Reject it for this adaptation goal. Awarding the badge for finishing the timed shift would make the badge unreachable under the 4-tick deadline, so keep the practice delivery as the way to earn it. A full retry check should leave zero deliveries even if one was made before restarting. Otherwise restarting can supply a second use for the same pair of parcels.

These traces establish which plans work in the paper rules. When trying it with a player, change the board and ask which plan they predict will succeed before they spend the cable use. If they can read the board and apply the rule, keep that as a first use. For a later shift, set both walk times to 3 and let a player who walks make a delivery and record a water reading for an optional survey of that depot. Cable delivery earns delivery credit alone. Both plans finish in 4 ticks and the player can advance one of two surveys. Test whether players use the cable to protect a survey they have chosen to finish. If the surveys give players no reason to pick a depot, change or remove them before adding more tiers.
