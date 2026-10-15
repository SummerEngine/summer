# summer_stop

Stop the running game. Use after runtime verification or when you intentionally need to restart the running instance; ordinary editor scene mutations do not require a blanket stop. Pass instance to stop ONE offscreen instance started with summer_play {instance, mode:'offscreen'} (the result reports was_playing and killed); omit it for the editor's main game.
