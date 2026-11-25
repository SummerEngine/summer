# General game development

Use this foundation with the [game-design router](../../SKILL.md) and the genre or craft specialist the request calls for. Work from the creator's stage of development. A theme needs possibilities, a playable scene needs observation, and a pile of working features may need a cut. If the creator asks for a line of dialogue, a map sketch or an art study, use their intent and constraints to make that piece in this turn. Keep creator replies free of book citations and reading lists.

## Help someone find their game

Listen for a place, feeling, fantasy, audience, constraint, or interaction the creator already cares about. Use their words. If they have a theme but cannot picture play, offer two short, genuinely different scenes in that setting and ask which is closer, or what both missed. Ask one question and wait. Treat each scene as an offer the creator can change.

A creator pictures the last night at a neighborhood ice rink. In one possible game, a skater tries to trace the old team’s crest in fresh ice before the lights go out. In another, the person at the music booth chooses a song for the last two regulars on the floor. One game asks for control over a line and its shape. The other asks the player to notice who is still there. “Which moment would you want to stay for?” is enough for this turn. If the creator says they simply want to hear the blades in the empty building, follow that answer. Let them make a pass, hear it fade and decide when to leave. A score or another character would change what that moment offers.

When the creator has a direction, talk through one short session. What invites the first action? What can the player do or express? What can they perceive afterwards? What changes their next action, or tells them they are done? A sketch in ordinary language is sufficient. Make clear which facts came from the creator and which rules you are proposing. When a teammate could build two very different scenes from the sketch, clarify the difference that matters to the creator.

## Choose the first thing worth making

Find the assumption that would force the most rework if it were wrong. Pick an artifact that lets someone actually try that part. Use stated limits such as a weekend, a phone screen, one local player, or an existing set of animations when choosing the size of the build. If an unknown constraint would change the next step, ask about it. Keep the first playable version small enough to rebuild after a surprising result.

| What is the creator trying to find out? | What belongs in the prototype? |
|---|---|
| Does steering a skate feel expressive? | Give the player one patch of ice, the intended control, a visible trail, and a way to try another line. The full rink and team history can wait. A drawing can establish a target shape. Trying the input reveals whether the player can create it. |
| Can a choice express how well someone knows a character? | Write two requests, two replies and the next reaction. Have a reader pick a reply and explain what they think the other person understood. Voice recording can wait unless vocal delivery carries the distinction. |
| Will strangers share information in time? | Put the information in different hands, keep the intended communication channel, and preserve the moment of commitment. One person seeing all the cards can check the answer. Two people can show whether they need each other to reach it. |
| Does an action matter after a break? | Write a short imagined session, carry its resulting state into tomorrow, and have a second person try to resume from what the game would show. Mark invented events as assumptions until the rules or a prototype support them. |

Before trying the prototype, let someone take the easiest shortcut it allows. If private clues are visible to both players, a successful solve tells you very little about cooperation. Fold each card so only its owner can read it, then see whether the players ask each other for the missing detail.

Describe a first build the creator can finish. Name the starting state, the one interaction to implement, the feedback or persistence it needs, and one tempting piece to defer. If they asked you to make it, carry that decision into the existing project and its normal tools. In a Godot project, the `make-game` skill provides the implementation sequence. For a Web Only game, follow its web entry point, current stack and controls. In a design conversation, a paper scene or a concrete change to try is a deliverable in its own right.

### Budget for what the idea has to do twice

Suppose the music-booth version has one finished song choice and one beautifully animated response. The creator can afford one more evening. Before commissioning songs for the whole rink, make a second, deliberately different choice with rough art and see what had to be authored again. Could the same reaction work differently because of who asked for the song? Does every track need a new animation and conversation? If custom reactions carry the emotion, a small cast with two carefully written moments may deliver the idea. If players chiefly enjoy choosing the music and watching its effect, a response the creator can reuse may leave more time for the music. Ask someone what they thought their choice expressed, then compare that account with the time it took the creator to make both possibilities.

Sometimes the risky part is technical. If the skater draws a smooth line with a mouse but loses it every time a finger covers the turn on the target phone, try the control and framing on one bend before authoring a course. If a friend must join midway and see the same mark in the ice, prove that one mark survives the handoff before building both players’ move sets. Use existing project assets or a stand-in for details the experiment can afford to get wrong.

## Review an existing game as a player would encounter it

Start with the route the creator actually has. For a broad review, follow one action from its first invitation through a later use and a consequence or stopping point. Note what the player has learned at each visit. Try an alternative that the game invites, or trace it from the rules. In a focused review do this around the reported moment. Prefer a specific place where an expectation fails to a list of every system in the project.

- **Follow the consequence across systems.** If you give a customer the last spare part today, what acknowledgment, opportunity, cost, or changed state reaches tomorrow? Follow both giving and keeping it. A thank-you can fulfill a promise of recognition. A promise that customers will help the shop recover calls for some reachable way they can help. Two working scenes can still lose that relationship at the transition.
- **Trace what the player can perceive and operate.** Follow an important cue to the last moment a player can act on it. Check sound, image, text, the required control, and what opening a hint does to time and movement. An objective can appear automatically, on request, or incidentally when someone opens a journal to reread the story. An open journal shows that the player could see the objective. Ask what they were looking for and what they noticed. If someone can explain the intended action but cannot perform it, observe the attempted input and the game's response. A missing key, an expired opportunity, an unreachable control and a rejected command need different fixes. Check a relevant alternative the game supports, such as muted play or a different input.
- **Follow recovery and closure.** On failure, what did the player learn, what do they retain, and how much must they repeat before they can try a new idea? After success, consider a player who has exactly what they came for. A quiet scene, satisfied exit or voluntary revisit can fulfill the creator's aim.

## Make one development decision

| What did you find? | What follows? |
|---|---|
| The player already makes the intended choice and values what it costs. | **Keep.** Identify the part that would be lost if you simplified it. |
| The choice exists but a cue, input, timing or consequence prevents someone from using it. | **Tune.** Change that moment and compare the same situation. |
| An obligation crowds out a more important activity. | **Cut for one trial.** Watch what players do with the time or resources they gain. |
| The promised action has no usable expression in the existing rules. | **Add one playable example.** Show what players can do differently before expanding it into a system. |
| Two explanations still fit. | **Test first.** Set up a comparison where those explanations predict different outcomes. |

Agree on an observation that would change the decision. A trace can establish what the rules allow. A playtest can show what someone attempted. Ask afterwards when the question is what they understood, enjoyed or feared. In a first-discovery test, use fresh players for the two versions so knowledge from the first attempt cannot give away the second. Tell the creator the next concrete step, what to preserve during it, and what result would lead you to keep the current game.
