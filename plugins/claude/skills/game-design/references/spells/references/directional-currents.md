# Make a current show the way

A bell opens one of two sluices in a flooded foundry. A stream of salt leaves a grate, curls around a brick pier and enters the open sluice. The player can arrive after the bell has moved. The visible stretch of current has to tell them which way to go.

## Lay out the cue at the fork

Draw the grate, pier and two exits. Mark the first spot where a player can see both branches and still choose. Draw a few arrows where the salt is visible from that spot, then carry those directions around the pier to the exit. Shift a section out from behind the near corner if the entry view hides the bend. Keep the blind side of the pier quiet so a decorative swirl draws little attention there. Make a sketch with each exit open.

Try a handful of small salt sprites moving along three slightly different paths. Give each a source at the grate and a place to disappear at the chosen exit. Add a little variation to birth time and speed. Follow a single cluster from the fork and check that it never crosses solid brick or reverses at the bend. If a player sees the salt and follows it backward, give the moving grains a recognizable entry and exit. A separate reflection or ripple layer can establish the water's scale without carrying that direction by itself.

## Extend the effect only as far as needed

A wide view may need a broad surface cue as well. Use separate controls for the broad direction and the repeating ripple detail. One option is a flow map, a texture that stores a direction and strength across the water. Paint enough samples around the pier to follow the corner, and keep the detail texture tiled at the intended grain. Display the directions as arrows before layering in the highlights. Start with little distortion, then inspect the grain at the bend and the whole surface over several loops.

| Artifact | Quick comparison |
| --- | --- |
| A recurring cluster makes the repeat obvious at one brick. | Follow a temporary marked grain for several loops. Spread spawn times or phase offsets and remove the mark before reviewing. |
| A stretched streak hides the original grain at the bend. | Try a shorter distortion interval with a soft overlap as one layer ends. Retain moving sprites for recognizable salt. |
| The whole pool brightens on the same beat. | Vary the loop phase across the pool. Check a wide view to see that large patches stay calm. |
| Salt seems to drift through the pier or toward the inactive opening. | Review the path positions and masks with the water highlights off. Test both switch states at the transition and after it settles. |

For an effect that is supposed to move a key, test the key's actual movement. Give the object a game rule that moves it toward its destination, and test contact with the pier and arrival at the pickup point. For the foundry cue, test that the visual state follows the open sluice even when both animations are transitioning.

## Ask which way the player went

Give unfamiliar visitors one first approach each. Compare the same fork with and without the cue and vary which sluice opens within each version. Record the first exit they commit to, how long the choice takes and what they followed. If most visitors point at the grate without choosing a direction, start more of the visible motion downstream. If they identify the correct exit and take the wrong walkway, inspect the visible connection to that exit.

For the rendering check, use the same flooded view and device with the simple ripple material, then the authored current. Record frame time in both. If layering the current causes a slowdown, compare with the surface layer removed while retaining the moving salt. Use the simpler version if players still read the bend and make the intended choice.
