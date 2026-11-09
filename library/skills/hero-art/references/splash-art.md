# Splash art: a roster that looks like one game

**Goal:** a wide, painted splash for each playable hero (character select, hero page, loading screen) that looks like it
came from the same art team as the person's best splashes. One weak splash makes the whole roster look cheap, so the job
is consistency first and novelty second.

The person's eye is the final gate. Generate options, show them full size, and let them name the exact image. Never pick
for them and never build anything on top of an image they have not named.

## The method that works

**1. Style comes from real references, side by side, in ONE image.** Image models copy a style far better from pixels than
from words. Pick 2 splashes the person loves (their own best ones, or references they give you), put them side by side
in one image, and use that as the reference:

```bash
magick a.png b.png -resize x1024 +append -depth 8 -quality 92 refs_pair.jpg
```

Upload it (`assets.upload_begin`, POST the file, `assets.upload_complete`, then `assets.get` for its URL) and pass it as
`referenceImageUrl` to `assets.generate_image` with `model: "gpt-image-2"`, `aspectRatio: "16:9"`, `width: 2688`,
`height: 1536` (or the largest the model reaches). For a brand-new character the prompt is short on purpose:

> Make a new original character based off this, in the exact art style. <Who they are in one line: adult man/woman,
> role, the fantasy>. <One pose that shows the role or signature ability>. <Scene>. No text, no logo, no frame, no UI.

For an existing character, combine the approved character art (concept or a 3/4 render of the in-game model) with 1-2
style splashes in the reference image, and say which panel is which: "the left panel is the character: keep the exact
face, hair, outfit and every colour; the right panels are the style only: paint a NEW wide splash of the left character
in exactly their painted style." Name every design element of the character in the prompt; anything you leave out drifts.

**2. Make 3-4 options, one seed each, and show them full size** beside the 2 style references and, for a redo, the old
splash. Ask the person to name the one they want, or what to change.

**3. Fix one region by paste-edit, never by re-rolling the whole image.** Image models redraw the face even when told to
"change only the hand". Edit, then paste only the fixed region back onto the approved pixels:

```bash
magick edit.png -resize <W>x<H>! edit_up.png
magick -size <W>x<H> xc:black -fill white -draw "rectangle x0,y0 x1,y1" -blur 0x14 mask.png
magick approved.png edit_up.png mask.png -composite fixed.png
magick fixed.png -crop <face box> f1.png; magick approved.png -crop <face box> f0.png
compare -metric AE f1.png f0.png null:     # must print 0: the face did not change
```

## Rules

- **Adults, attractive, on-model.** Heroes read as confident adults. Each edit tends to make bodies plainer and stockier
  and faces younger; compare every output with the approved image and reject drift.
- **Check the weapon and the hands up close** before showing anything. Bows without strings, crossbows with broken limbs,
  six fingers and fused hands are common. Name the weapon's parts in the prompt; fix by paste-edit.
- **A splash that reads as glossy, airbrushed and generic gets redone** in the style of the good set, using the old
  splash only as the design reference. Sharpen the style words: visible brush texture, bold shapes, strong rim light,
  warm-and-cool lighting, a detailed scene.
- **Same framing across the roster**: same aspect, the hero large and central, similar head height, so the select screen
  does not jump between picks.
- **No text, logos, frames, watermarks or credits in the art**, and no caption that names how it was made.
- Keep the full-size master; ship a resized copy (`magick master.png -resize 1344x768 -depth 8 hero_splash.png`).

## Into the game

Import the copy (`summer_import_from_url` or copy it into the project) next to the other splashes, keep one naming
pattern (`<hero>_splash.png`), and show it with a `TextureRect` (`expand_mode` ignore size, `stretch_mode` keep aspect
covered). Verify with `summer_screenshot` on the select screen beside 2 other heroes.

## Done means

- The person named the exact image; its master and game copy are saved; the weapon, hands and face pass a close look.
- Record the pick, the reference pair and the prompt in `.summer/art-bible.md` so the next hero uses the same recipe.
- Next: `splash-loop.md` to bring the splash to life, or `hero-character.md` to build the 3D model from the approved art.
