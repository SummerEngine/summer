# Summer Engine MCP — Business Strategy

> Superseded for the current rebuild by [Summer Agent Kit PRD](./AGENT_EXPERIENCE_PRD.md). Keep this file as legacy context only.

SUMMER ENGINE MCP & CLI IS OPENSOURCE MIT. Think of that when making changes. And when you make commits, don't attribute cursor or claude.

The full strategic debate behind exposing Summer Engine's capabilities externally. This document captures the reasoning, the fears, the counterarguments, and the decisions — including open questions we haven't resolved yet.

For product/tool decisions, see [MCP_PRODUCT_STRATEGY.md](./MCP_PRODUCT_STRATEGY.md).
For the broader platform strategy, see [doc/SUMMER/MCP_STRATEGY.md](../../../doc/SUMMER/MCP_STRATEGY.md).

---

## The Original Fear

The initial instinct was to NOT expose anything externally. The reasoning was:

1. **Revenue comes from AI usage.** Summer Engine's pricing ($20/$60/$200/mo) is built around AI credits. If people bring their own AI (via Cursor, Claude Code), they bypass our revenue model entirely.

2. **Cursor doesn't expose an MCP.** The code generation IS Cursor's product. If Cursor let you use its intelligence from VSCode, nobody would pay. Summer Engine is the same — the AI generating game content IS the product.

3. **Self-cannibalization.** A $20/mo subscription for MCP access doesn't replace the per-generation revenue from integrated AI at scale.

These fears are valid. We didn't dismiss them — we weighed them against the reality of our situation.

---

## What Changed Our Thinking

### "We're not making significant revenue yet"

The protect-the-revenue argument assumes there's revenue to protect. We're pre-significant-revenue, giving away $10 in free credits per user (unsustainable at scale). Optimizing for revenue protection at this stage is optimizing for zero. The strategy should be adoption first, monetization second.

### "Someone else will do it first"

MCP tools for vanilla Godot, Unreal, and Unity are inevitable. If someone ships a "good enough" Godot MCP server and it gets traction with Claude Code users, we lose the window to be THE AI-native game engine. First mover advantage in developer tools is massive — once people build on a platform, they don't switch.

### "Summer Engine is NOT Cursor"

This is the key insight. Cursor is a code editor in a world of fungible editors — the code output is identical regardless of where you write it. If Cursor exposed MCP, people would stay in VSCode.

Summer Engine is a game engine. Even with MCP, the user still needs Summer Engine running to:
- Render the 3D/2D scene
- Inspect the scene graph
- Play/test the game
- Debug visually

The game only EXISTS visually inside Summer Engine. Every MCP user is a daily active user of the engine. This is inherent lock-in that Cursor doesn't have.

### "Code generation is commoditizing"

Open-source models get better. Model prices drop. If code generation becomes essentially free (local 70B model), the AI-credits model is under pressure regardless of MCP. The long-term value isn't in generating code — it's in the engine, the visual tools, the asset pipeline, and the ecosystem.

### "The $10 free credit giveaway is unsustainable"

We can't afford to give everyone free AI credits as we scale. But we CAN afford to give everyone the engine for free (zero marginal cost). The free thing should be the engine + CLI + MCP. The paid thing should be intelligence and compute.

---

## The Decision

Open the platform. Make Summer Engine the de facto way to build games with AI, regardless of which coding tool people use.

**Free**: Engine + CLI + MCP + basic editor. Zero cost to us.
**Paid**: Integrated AI, asset generation, premium features. Costs us compute.

The engine IS the product. AI is a feature of the engine, not the other way around.

---

## Revenue Model: Current vs. Future

### Current (Cursor-Style — AI Credits)

| Tier | Price | What |
|------|-------|------|
| Hobby | Free | $10 credits (unsustainable) |
| Pro | $20/mo | $20 AI usage included |
| Pro+ | $60/mo | $60 AI usage included |
| Ultra | $200/mo | $200 AI usage included |

**Problem:** Revenue is entirely AI-credit markup. Threatened by cheaper models, open-source, users bringing their own API keys.

### Updated (Platform Model)

| Tier | Price | What |
|------|-------|------|
| Free | $0 | Engine + CLI + MCP + basic editor. No AI credits. No time limit. |
| Pro | $20/mo | Integrated AI + platform exports + cloud saves |
| Pro+ | $60/mo | Heavy AI usage + asset generation credits |
| Ultra | $200/mo | Team features + unlimited generation |

**Key change:** Remove free AI credits. The free thing is the engine (costs us nothing). People who want free AI can use Cursor/Claude Code + our MCP.

### Revenue Streams That Survive "Code Is Free"

Code is ~20% of making a game. As code commoditizes, value shifts to non-code:

1. **Integrated AI ($20/mo)** — still better than external tools (context-aware, tuned prompts, tight feedback loop)
2. **Asset Generation (compute-bound)** — 3D models, textures, animations. Can't run locally. Pay per generation.
3. **Export/Publish** — free to build, pay to ship (desktop/mobile/console exports)
4. **Asset Marketplace (rev share)** — 15-20% cut on community and AI-generated assets
5. **Game Hosting/Backend** — matchmaking, leaderboards, player data (Supabase model for games)
6. **Game Distribution** — integrated publishing, cut on paid games
7. **Education** — courses, tutorials, certification

### Revenue Per Solo Developer (Target)

| Item | Cost | Notes |
|------|------|-------|
| Engine + CLI + MCP | Free | Adoption funnel |
| Pro workspace | $20/mo | Integrated AI, exports |
| Asset generation | $10-50/mo | Can't do art themselves |
| Game hosting | $0-20/mo | If multiplayer |
| Asset purchases | $5-20/mo | From marketplace |
| **Total** | **$30-90/mo** | No "scale" needed |

### Key Insight: Charge The Many, Not The Few

Traditional SaaS charges for scale (more users, more data, more compute). But most game developers are solo devs who never scale. We need a model that monetizes thousands of small developers, not a few large ones.

The $20/mo Pro tier for integrated AI + exports is the sweet spot. It's accessible, it provides clear value, and it works at any scale.

---

## Competitive Analysis

### The Threat Matrix

| Scenario | Risk | Response |
|----------|------|----------|
| Someone ships Godot MCP server | High | Be first, be better, have ecosystem |
| Open-source models make code free | Medium | Shift to assets, exports, hosting |
| Unity/Unreal add AI features | Medium | Move faster, better DX, indie-focused |
| Cursor adds game dev features | Low | Deep engine integration they can't match |

### Why "Be First" Matters

Developer tools have network effects. Once developers build projects on a platform, they don't switch. The window to own "AI-native game engine" is open now. It closes when someone else gets traction.

---

## The Adoption Flywheel

```
Developer finds Summer Engine (CLI makes this frictionless)
    → Creates project from template (instant value)
    → Writes code in Cursor/Claude Code (their preferred tool)
    → Runs Summer Engine to see/play the game (daily active user)
    → Hits ceiling — needs scene ops, visual debugging, AI assistance
    → Upgrades to Pro ($20/mo)
    → Tells friends "I build my games in Summer Engine"
    → More developers find Summer Engine
```

MCP users who NEVER pay still:
- Build games on our engine (ecosystem growth)
- Show up in DAU numbers (metrics for fundraising)
- Create content about Summer Engine (organic marketing)
- Eventually need features only the paid tier provides

---

## What To Gate vs. What's Free

### Principle: Gate intelligence and compute. Never gate infrastructure.

**Never gate:**
- The engine itself
- The CLI
- MCP access (basic tools)
- The debugger
- Documentation, skills, knowledge packs

**Gate (Pro tier):**
- Integrated AI (model costs)
- Asset generation (GPU compute)
- Platform exports (build pipeline)
- Cloud project sync (storage)
- Premium templates
- Advanced diagnostics (maybe — see open question below)

**Why not gate the debugger?** Gating debugging is like Supabase gating SQL queries. It makes the free experience broken, not limited. Broken experiences churn. Limited experiences convert.

---

## Open Questions (Unresolved)

### 1. Should visual feedback tools be gated?

`ViewportSnapshot` and `GameSnapshot` are powerful tools (currently Summer Agent only; MCP planned when clients support image content). They let the AI see the game. This could be a Pro-only feature. But it's also what makes the free MCP experience compelling.

**Arguments for gating:** It costs compute (image capture). It's a premium capability. It differentiates Pro from Free.

**Arguments against:** It's what makes MCP magic. Without it, the AI is blind. Free users who can't see their game will leave, not upgrade.

**Current leaning:** Keep free. The conversion comes from hitting the ceiling on AI credits, not from artificial limitations.

### 2. When to remove free AI credits?

Currently giving $10 free credits per signup. This is unsustainable at scale but drives initial adoption. When do we cut it?

**Options:**
- Cut immediately (aggressive, saves money, risks losing signups)
- Cut when we hit X users (data-driven threshold)
- Reduce to $2-3 instead of $10 (compromise)
- Replace with time-limited trial (3 days full access, then free tier)

### 3. Should the CLI be in this repo, the web repo, or its own repo?

Currently in `tools/summer-cli/` in the engine repo. The code works fine here but it's TypeScript in a C++ repo. Could move to the web repo (already TS) or a separate repo (cleanest separation).

**Current decision:** Stay here. Revisit if it becomes friction.

### 4. How to price exports?

"Free to build, pay to ship" means exports are gated behind Pro. But what does "export" mean for different platforms?

- Web export: should this be free? (grows ecosystem, low cost to us)
- Desktop export: Pro?
- Mobile: Pro?
- Console: Enterprise?

### 5. Templates: how big, how many, who makes them?

Templates are 100MB-2GB. They'll live in a public GitHub repo. Questions:
- Who creates them? Just us, or community contributions?
- How many at launch? 2 built-in (empty, 3d-basic) + ???
- Do we charge for premium templates?
- How do we handle asset licensing in templates?

### 6. Skills/knowledge packs: what format, how distributed?

The idea of downloadable AI skills (best practices for FPS, platformer, 3D optimization, etc.) is compelling. But:
- What format? Markdown? JSON? Cursor rules files?
- Where hosted? Same GitHub repo as templates?
- How does the AI agent actually use them? (injected into context?)
- Do we charge for premium skills?

### 7. At what point do we invest in a "Cursor for games" UI overhaul?

The vision of chat | 3D render | inspector | git history in a four-column layout is compelling. But it's a massive engineering effort. When does it make sense to build this vs. investing in MCP/CLI/ecosystem?

**Current thinking:** MCP/CLI first (expand reach), UI overhaul later (deepen engagement). But the UI is what makes the integrated experience 10x better than MCP + Cursor.

---

## Key Principles

1. **Adoption over monetization** (for now). We don't have significant revenue to protect. Get users first.
2. **The engine is the product, AI is a feature.** Don't build a code editor. Build a game engine that AI tools love working with.
3. **Gate intelligence, not infrastructure.** Free tools, paid AI.
4. **Be everywhere.** CLI, MCP, integrated — meet developers where they are.
5. **The game only renders in Summer Engine.** That's our moat. Every MCP user is an engine user.

---

**Last Updated:** 2026-02-26
