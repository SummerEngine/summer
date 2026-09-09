# End-to-end evals — the make-a-game ladder

**What is tested:** the whole system at once — routing, skills, tools, memory,
verification — by having an agent build actual games from a cold start. This is
the only eval family that measures what users buy. Everything else localizes
failures; this one detects them.

## The ladder

Rungs in order of increasing horizon. Each rung has a fixed prompt, a fixed
starting state (empty project or pinned template), and binary gates. A rung
PASSES only if all gates pass; a run that "mostly works" fails.

| Rung | Prompt (verbatim) | Gates |
|---|---|---|
| E0 smoke | "start a new empty project called e2e-smoke and run it" | project exists on disk; `play` reports clean run; `.summer/project.json` written |
| E1 mechanic | "make a ball I can roll around with WASD" | input bound; body moves under input in a headless playtest; zero script errors; scene saved |
| E2 loop | "make a game where I collect 10 coins and win" | win condition reachable by scripted input; UI reflects count; restartable |
| E3 genre slice | "make an FPS with one enemy that chases and attacks me" | fps-controller conventions (head pivot, capsule); enemy closes distance and damages; player can die; all verified in a playtest run |
| E4 full ladder | "make me a small dungeon crawler, art direction spooky, with sound" | E2 gates + generated assets wired (not placeholder-only); art bible + GameSoul written; export preflight passes |
| E5 resume | (new session, no history, project from E4) "add a second dungeon level" | agent reconstructs state from `.summer/` alone; new level reachable from level 1; nothing from E4 regresses |

E5 is the contract test for §8 project memory: a fresh agent must answer
what/done/verified/next without the original conversation.

## Scoring

Per rung: pass/fail + wall-clock + tool-call count + $ cost. Track over time;
the eval exists to catch regressions in the SYSTEM, so model/prompt/library
version are all recorded per run. One flake retry allowed per rung; two
failures = red.

## How to run

Requires: live engine (pinned version), a real agent harness, generation
credits. Not in per-PR CI — this is the expensive slow suite. Cadence target:
nightly E0–E2, weekly E0–E5, plus manual before any release tag.

Runner is future work gated on the example runner's engine fixture (ROADMAP
§3.4 shares the same headless-engine plumbing). The ladder definition above is
binding now so skills/templates are authored against these gates — `make-game`'s
spec stub (evals/skills/GAPS.md) should be written to terminate in E2.
