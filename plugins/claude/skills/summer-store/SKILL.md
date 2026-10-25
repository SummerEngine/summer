---
name: summer-store
description: "Sell Summer items for Sparks: shop, checkout, slugs, bundles, sales, owned items, summer.items.json sync."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Edit Write summer_get_script_errors summer_project_setting summer_play summer_stop summer_get_diagnostics summer_run_script summer_sync_items
paths: ["**/*.gd", ".summer/test-users.json", "summer.items.json"]
---

# /summer-store — sell items, check what players own

## Overview

Players pay with **Sparks**, Summer's currency. Your game never touches money,
balances or approval:

1. The client lists your published offers with `Summer.client.store.list_items()`.
2. The player presses Buy. The client asks for a checkout with offer ids and quantities, never prices.
3. The Summer app shows its own purchase sheet. The player approves or declines there.
4. Summer charges the Sparks and issues the item into the player's **inventory**.
5. The game sees the item in `Summer.client.items` (client) and `Summer.authority.items` (authority).

The ids, kept apart:

| Id | Where it comes from | Use it for |
| --- | --- | --- |
| Slug ("Item key" in Studio) | You choose it, e.g. `party_hat`; the same in staging and production | Recognizing an item in game code |
| Definition id | Summer assigns it (`item_…`); **differs between staging and production** | The same, on Summer versions without the slug getters |
| Offer id | `item.price.offer_id` in the store listing | `SummerCheckoutLine.create(offer_id, quantity)` |
| Owned item id | One owned copy (`item.get_owned_item_id()`) | Pointing at a specific owned copy |

The rule that makes it cheat-proof: **the authority decides what a player may
use by reading that player's inventory itself.** A client saying "I bought it"
proves nothing.

**What runs where:**

| Surface | Store and checkout | Inventory |
| --- | --- | --- |
| Hosted | Need the Summer app's `player.store.read@1` / `player.store.checkout@1` | Needs `player.items@1` |
| Local Play | `unavailable` | Works from a fixture: empty unless `.summer/test-users.json` lists item templates (step 7) |
| Guests, older Summer apps | Readiness reports `unavailable` | Readiness reports `unavailable` |

This skill extends the Courtyard game from `multiplayer-project` and
`multiplayer-state`.

## Where items come from

**Game code never creates or grants items at runtime.** The creator defines
them, Summer reviews each one, and the owner activates it. Two ways in:

| Way | How | Who writes |
| --- | --- | --- |
| Studio | The game's item pages (`studio.open` target `game`): create, Item key, price, submit for review | The owner |
| `summer.items.json` | A file in the project root, synced with `summer_sync_items` (CLI `summer economy sync-items`) | An agent **proposes**; the owner approves in Studio, and Studio applies it |

An agent never writes an item or a price itself. Bundles and sales (step 5)
are not in the file; they belong to the store page draft, which the owner
publishes.

### How an item becomes buyable

Today an item goes on sale only after all of these:

1. **Defined.** In Studio, or from a sync plan the owner approved (Studio
   applies it). Approving the plan does not put anything on sale.
2. **Reviewed.** Each item is submitted for Summer's review. Its page shows
   the state; "Check verification status" reads the result.
3. **Activated, one item at a time.** Once Summer approves an item, the owner
   presses **Review activation** on that item's page in Studio and confirms.
   Nothing activates it for them: not the sync, not an agent.
4. **The Game is live.** An active item is buyable only while its Game's
   store page is live. It stops selling while the Game is unlisted and
   resumes when the Game is listed again. An item can be activated before
   the Game goes live; it sells from the moment the Game is live.

**Editing a live item makes a new revision.** In Studio that is "Review new
revision"; in a sync plan it is an `update` with `"revision": "new_draft"`.
Players keep buying the live revision while the new one is reviewed, and
the new one replaces it only after the owner's Review activation of it.

**Coming:** Summer has decided that items will go on sale without waiting for
Summer's review. Staff will review an item after it goes live and can take
it down. The store change that does this is being built and has not shipped.
Until it ships, follow the four steps above. When it ships, steps 2 and 3
no longer hold up the sale; a live Game is still required.

### `summer.items.json`

```json
{
  "schema": "summer.items/v1",
  "items": [
    {
      "slug": "party_hat",
      "name": "Party hat",
      "description": "A paper crown for the courtyard.",
      "class": "COSMETIC",
      "cosmetic": {"familyId": "hat", "variantKey": "party"},
      "ownershipMode": "INSTANCE",
      "ownership": "OWNED",
      "priceSparks": 150,
      "media": ["art/items/party_hat.png"]
    },
    {
      "slug": "confetti",
      "name": "Confetti",
      "description": "One burst of confetti.",
      "ownershipMode": "QUANTITY",
      "consumable": true,
      "priceSparks": 10,
      "media": ["art/items/confetti.png"]
    }
  ]
}
```

| Field | Rule |
| --- | --- |
| `slug` | Required, unique in the file: 1–64 lowercase letters and digits, words joined by one `.`, `_` or `-`, starting with a letter |
| `name`, `description` | Required; at most 120 and 5000 characters |
| `class` | `STANDARD` (default) or `COSMETIC`; a cosmetic needs `cosmetic.familyId` and `variantKey` |
| `ownershipMode` | `INSTANCE` (default; one copy is one owned item) or `QUANTITY` (a stack). Class and mode never change later |
| `maxOwned` | Optional cap on copies per player (step 4) |
| `ownership` | `SOULBOUND`, `OWNED` (default) or `MARKETABLE`; `consumable` is true or false |
| `supply` | Optional lifetime limit; omit for unlimited |
| `priceSparks` | Whole Sparks. Omitted: a new item is not sold, an existing price stays |
| `media` | Project-relative `.png`, `.jpg`, `.webp` or `.glb`, in store order. **A new item needs at least one image** |

### Sync it

1. **Plan (dry run).** `summer_sync_items {"gameId": "game_..."}` reads the
   file and the Game's items by slug, and changes nothing. It answers create,
   update (with the changed fields), unchanged, blocked (with the reason),
   and the Game's items the file does not name (listed, never changed).
2. **Show the plan to the user** and ask before sending it.
3. **Confirm.** `summer_sync_items {"gameId": "game_...", "confirm": true}`
   uploads the changed images and sends the plan to the owner. The answer is
   `awaiting_owner_approval` with an approval link: give it to the owner.
   Nothing changes until they approve in Studio. Then each item is created
   or revised, priced and submitted for Summer's review. Each one still
   needs Summer's approval and the owner's Review activation before players
   can buy it ("How an item becomes buyable").
4. **One approval takes at most 50 items.** A larger plan lists `batches`;
   confirm each one with `"slugs": [...]` and pass on each approval link.

Activating an item (Review activation), retiring it, and the Game's own
price are not part of the sync. The owner does those in Studio. A Passport
collectible (a stamp, pin or badge) with the same slug is **blocked**:
Passport items have their own lifecycle and are never synced; give the
store item another slug.

**Staging and production.** One file serves both, because items match by
slug. Game ids differ, so take `gameId` from that environment's game list.
The machine holds one store sign-in. To switch, set `SUMMER_GATEWAY_URL` and
`SUMMER_MCP_RESOURCE_URL` for the other environment, then run
`summer login --store --force`. Until then the sync stops with
`store_login_other_environment`.

### Slugs

- Set in Studio ("Item key", on create or on the item page) or from the file.
- Unique within the Game, and the same in staging and production.
- **Frozen once the item's first publication is claimed**, even if that
  publication fails or the item is retired. Before that it can change, and an
  item without a slug can get one at any time.
- Never reused by another item of the Game, so game code and the authority
  can safely name items by slug.

**Availability: the platform sends slugs; the game needs the getters.**
Since 2026-10-16 Summer sends every item's slug to games: the store listing
carries `StoreItem.slug` and the inventory `InventoryItem.definition_slug`.
Game code reads them with `SummerStoreItem.get_slug()`,
`SummerInventoryItem.get_slug()`, `SummerClientItems.has_owned_slug()` and
`SummerItemSelection.allowed_slugs`. Those getters are not in Summer 0.7.3;
they come with the next Summer Engine release that carries them (0.7.4, in
progress). Check the version the game runs on before relying on them. Local
Play fixtures carry slugs too (step 7).

| Check | Result |
| --- | --- |
| `summer_run_script {"scenePath": "res://main.tscn", "source": "func run(ctx):\n\tctx.report(\"slugs\", ClassDB.class_has_method(\"SummerClientItems\", \"has_owned_slug\"))"}` | `slugs: true`: this Summer version has the getters |
| No MCP: write the slug code, then `summer_get_script_errors` | A "not found" error on `has_owned_slug` or `get_slug`: this version lacks them |
| Hosted: `get_slug()` returns `""` | That item has no Item key yet: set one in Studio or in `summer.items.json` |

Without the getters, use the definition-id variants in steps 1–3, with each
environment's definition ids.

## Steps

### 1. The client shop

`client/shop.gd`, a child `Shop` of `Main`. In `client/main.gd`'s `_ready()`, call
`$Shop.start()` right after `Summer.initialize` succeeds:

```gdscript
extends Node
## A shop for Summer items, paid in Sparks. Summer shows its own purchase
## sheet; the game never sees money and never grants an item itself.

signal shelf_changed(rows: Array)          # [{name, sparks, offer_id, slug, owned}]
signal checkouts_changed(busy: bool, rows: Array)
signal status(text: String)

var store: SummerClientStore
var items: SummerClientItems


## Main calls this right after Summer.initialize succeeds: a child's _ready
## runs before that, while Summer.client is still null.
func start() -> void:
	store = Summer.client.store
	items = Summer.client.items
	# Connect before reading retained statuses; a normal (not deferred)
	# connection is how the SDK knows a result was delivered.
	store.checkout_status_changed.connect(func(_status: SummerCheckoutStatus) -> void: _render_checkouts())
	items.refreshed.connect(_on_items_changed)
	items.item_replaced.connect(func(_change: SummerInventoryChange) -> void: _on_items_changed())
	items.item_removed.connect(func(_change: SummerInventoryChange) -> void: _on_items_changed())
	_render_checkouts()


## Opening the shop screen.
func open() -> void:
	var readiness := store.check_browse_readiness()
	if not readiness.ok:
		status.emit("The shop is not available here.")   # hide the shop button
		return
	var page := store.list_items(50)
	var listed: SummerResult = await page.get_result_or_completed_signal()
	if not listed.ok:
		status.emit("The shop could not load.")
		return
	var rows := []
	for item in page.items:
		if item.price != null and item.price.offer_id != "":
			rows.append({"name": item.name, "sparks": item.price.sparks_amount, "offer_id": item.price.offer_id,
				"slug": item.slug, "owned": owns(item.slug)})
	shelf_changed.emit(rows)
	if items.check_refresh_readiness().ok:
		items.refresh()


## The Buy button. One call is one purchase: never call it again to retry.
func buy(offer_id: String) -> void:
	if not store.check_checkout_readiness().ok:
		status.emit("Purchases are not available here.")
		return
	if store.has_pending_checkouts():
		return
	var lines: Array[SummerCheckoutLine] = [SummerCheckoutLine.create(offer_id, 1)]
	var operation := store.request_checkout(lines)
	_render_checkouts()
	await operation.get_result_or_completed_signal()
	_render_checkouts(operation)


func _render_checkouts(operation: SummerCheckoutOperation = null) -> void:
	var view := SummerCheckoutObservation.capture(store, operation)
	var rows := []
	for checkout in view.statuses:
		rows.append({"id": checkout.request_id, "state": checkout.state, "error": checkout.error_code})
	checkouts_changed.emit(view.has_pending_checkouts(), rows)
	var failure := view.submission_failure
	if failure != null:
		var reason: StringName = failure.service_error.reason if failure.service_error != null else failure.code
		if reason == &"already_owned":
			status.emit("You already own this.")   # show the row as Owned; nothing was charged
		else:
			status.emit("The purchase did not start: %s" % reason)


## Ownership comes only from the inventory, never from a checkout result.
func owns(slug: String) -> bool:
	return items.is_projection_loaded() and items.has_owned_slug(slug)


func _on_items_changed() -> void:
	status.emit("Inventory updated.")
```

On a Summer version without slugs, drop `"slug"` from the rows, pass the
item's per-environment definition id, and use:

```gdscript
func owns(definition_id: String) -> bool:
	return items.is_projection_loaded() and items.has_owned_definition(definition_id)
```

Bind `checkouts_changed` to the Buy buttons: disable them while `busy` is
true, and for rows with `owned` true. Update rows by `id`; a status can be
delivered again after a crash, so rendering must be idempotent. Show each
checkout state:

| `state` | Show |
| --- | --- |
| `awaiting_approval`, `pending` | "Waiting for Summer…" |
| `purchased` | "Bought!" The item arrives through the inventory signals, possibly a moment later |
| `declined`, `expired` | Nothing, or "Cancelled" |
| `rejected` with `error_code` `insufficient_funds` | "Not enough Sparks" (players get Sparks in the Summer app) |
| `rejected`, other codes | "The purchase was not completed" |
| `manual_review` | "We're confirming this purchase." Not done, not failed |

### 2. Unlock from the inventory only

Unlock cosmetics in menus with `owns(slug)`, and refresh the menu on
`refreshed`, `item_replaced` and `item_removed`. Never unlock from a
`purchased` status: the receipt proves the debit, the inventory proves
ownership, including after a reinstall or on another device. An empty
inventory before `is_projection_loaded()` is "still loading", not "owns
nothing". Match by slug, never by item name, and never hard-code one
environment's definition ids.

### 3. The authority checks entitlement

Anything that changes the match because of an item goes through a Command, and
the authority reads that Session's inventory. Add `"equip"` to the `match` in
`authority/main.gd`'s `_on_command`:

```gdscript
		"equip":
			_equip(request, str(command.get("hat", "")))
```

```gdscript
## The hats this game knows, by slug: the same in staging and production.
const HATS := ["party_hat", "top_hat"]


## A player asks to wear a hat. The authority reads that Session's inventory
## itself; a client saying "I own it" proves nothing.
func _equip(request: SummerNetworkCommandRequest, slug: String) -> void:
	if not HATS.has(slug):
		request.refuse(&"unknown_item")
		return
	var session := request.get_session()
	var read := Summer.authority.items.inventory_for_session(session)
	var result: SummerResult = await read.get_result_or_completed_signal()
	if not result.ok:
		request.refuse(&"inventory_unavailable")   # retryable: try again later
		return
	for item in read.items:
		if item.is_owned() and item.get_slug() == slug:
			var hats: Dictionary = match_doc.get("hats", {})
			hats[session.player.user_id] = slug
			match_doc["hats"] = hats
			match_group.reset(Game.pack(match_doc))
			request.accept({}, Game.pack({"equipped": slug}))
			return
	request.refuse(&"not_owned")
```

The client sends `await command({"c": "equip", "hat": slug})` and every client
draws hats from `match_doc.hats`. Other players see the hat only because the
authority published it.

**Without slugs** (Summer versions without the getters, or an item with no Item key):
keep each environment's definition ids, send the definition id, and compare
`item.get_definition_id() == definition_id` instead of `item.get_slug() == slug`.

For an equipment slot, `SummerItemSelection` does this check for you: set
`selection.allowed_slugs = PackedStringArray(["party_hat"])`, then call
`configure_slot` with an empty definition allowlist. An item whose inventory
carries no slug never matches, so the slot fails closed until it has one.

`Summer.authority.items.inventory_changed(session, change)` hints that a
player's inventory changed during the match. To drop an item that was
refunded mid-match, re-read with `inventory_for_session` (or
`refresh_inventory`) on that hint.

### 4. Owned items and `maxOwned`

| Item | Can a player buy another? |
| --- | --- |
| Unique (`INSTANCE`, not consumable) | No, once they own one |
| `maxOwned` N (not stackable, not consumable) | Until they own N |
| Stackable (`QUANTITY`) or consumable | Yes; unaffected |

Summer counts owned copies plus purchases still settling. A checkout with no
room left is refused with **`409 already_owned`** before anything is charged,
and of two simultaneous purchases of the last copy, one is accepted. In game
code that is a `submission_failure` whose reason is `already_owned` (step 1):
show "Owned", not an error. The Summer apps' shops already show **Owned**
instead of Buy; in your own shop, set `owned` from the inventory and disable Buy.

### 5. Bundles and timed sales

They live on the store page draft; saving never publishes. Players see them
once the owner publishes the store page again (`store.publish`, owner-approved).

**In Studio** (`studio.open` target `/studio/store/:gameId`, the **Store page** tab):

- **Bundles** card: **Add bundle**, name it (the key comes from the name and is fixed once published), pick the Items (one without a price can't be picked; a stackable takes a quantity), set the Sparks price. The line under the price shows the Items total and "Save N%". Optional: a minimum price, and "On sale from" / "Until" dates. **Save bundles**. Removing a bundle removes its sales too.
- **Sales** card: **Add sale**, pick an Item or a bundle, the percent off and the start and end dates; it shows the result ("400 → 280 Sparks"). **Save sales**. A sale that has ended is dropped on save.
- **Sold only in bundles:** the checkbox on an Item's row in a bundle, or the toggle on the Item's page. A refusal shows at the field to fix.

**As an agent:** ask the owner before saving, then use `store.set_bundles` and `store.set_sales`.
`store.get_listing` returns `itemStore`: the bundles with `itemsTotalSparks` and `savePercent`, the sales with `listSparks` and `saleSparks`, `bundleOnlyItemIds`, and the Game's Items with ids and Sparks prices.
Each call **replaces the whole list**, so send every bundle or sale to keep; `[]` clears it. A bundle without a key keeps the saved key of the same name; `bundleOnlyItemIds` on `store.set_bundles` sets the bundle-only Items. A refusal names the field, e.g. `storeBundles[0].priceSparks`.

| | Rules |
| --- | --- |
| **Bundle** | A fixed list of 1–16 of the Game's items, 2–64 units in all (1 of a unique item, up to its stack for a stackable). A stable key, a name of at most 40 characters, up to 20 per Game. A purchased bundle never changes |
| Bundle price | The creator's Sparks price: at least 1 Spark per unit, below what its items cost alone. Shown with the items' total crossed out and "Save N%". Optional minimum price, and an optional available-from/until window (a limited-time bundle) |
| **Sale** | 1–90% off one item or one bundle, between a start and an end at most 90 days apart. The old price shows crossed out, with the end time |
| **Bundle-only item** | Sold only inside its bundles, never listed or bought alone (`409 not_sold_alone`) |

**A player who owns some of a bundle's unique items** gets those left out,
and the price drops by their share of the regular base prices:
`bundle price × base of the items not owned ÷ base of all its items`. It is
computed exactly, held at least at the minimum and at 1 Spark per unit, then
rounded up once, and never costs more than buying the remaining items
separately. Stackable and consumable items always count. Owning everything
shows **Owned**. Only the bundle total is promised; each item's share on the
receipt just splits it.

**Where players see them:** the Game shop in the Summer apps (website,
desktop, iPhone, Android) shows a Bundles row, "Save N%", "You own 2 of 5",
"Ends in …", and "This offer ended" (nothing charged) when a sale or bundle
window closes before the purchase.

**In your in-game shop:** `list_items` shows a running sale's price as the
item's price (no crossed-out price) and leaves bundle-only items out. Bundles
are not sold in game yet; point players to the Game shop in the Summer app.

### 6. Rules and why

- **Offer ids and quantities only.** Never send a price, an amount or a buyer. The platform prices everything, sales and bundles included, and a client-side price is what a cheater edits.
- **One `request_checkout` is one purchase.** Each call gets a new identity. Never call it again because a result is slow; `is_outcome_unknown()` means it may already be charged, and the status will still arrive.
- **Connect `checkout_status_changed` normally, before reading statuses.** A synchronous handler is how the SDK knows the result was delivered; a deferred-only handler leaves it undelivered.
- **`pending` and `manual_review` are not failures.** Don't show success or failure until a terminal state.
- **Carts:** 1–16 different offers, at most 64 units, as one atomic purchase.
- **Hide what's unavailable.** `check_browse_readiness()` and `check_checkout_readiness()` return a `SummerResult`; show the shop only when they're `ok`.

### 7. Test

**Local Play.** The store and checkout report `unavailable`, so the hidden-shop
path is what you test. Inventory and the authority check work from a fixture:
create `.summer/test-users.json` with item templates. Give them slugs with
`catalog_item_slugs`, only on a Summer version with slug getters; older ones
refuse the field.

```json
{
  "schema": "summer.local-fixture.v1",
  "fixture_id": "courtyard",
  "fixture_version": 1,
  "seed": 1,
  "world_definition": "world.json",
  "service_outcomes": [],
  "catalog_item_templates": ["hat"],
  "catalog_item_slugs": [{"template": "hat", "slug": "party_hat"}],
  "personas": [
    {"persona_id": "alice", "display_name": "Alice", "participant_role": "player", "eligible_for_outcome": true, "session_lifetime": "match_bound"},
    {"persona_id": "bob", "display_name": "Bob", "participant_role": "player", "eligible_for_outcome": true, "session_lifetime": "match_bound"}
  ]
}
```

What the fixture gives you:

- Every persona owns one item per template.
- Each item has the slug you gave its template: Bob's hat is `party_hat`, so slug code behaves as it will once slugs are delivered.
- Other ids are local stand-ins: owned item id `local-item:bob:0`, definition id `local-definition:courtyard:0`, `item_template_version_id` `"hat"`. Without slugs, equip with the local definition id the client reads from `items.get_owned_items()`.

**Staging.** Summer staging is a separate environment: its own sign-in,
Games and definition ids (one `summer.items.json` still serves both). Your
production account and Games are not in it; if you have no staging account,
ask Summer for access. Purchases there use test payments: Sparks bought in
staging are sandbox Sparks, nothing real is charged, and they earn the
creator nothing. Test a purchase with a staging account that bought Sparks
in the staging Summer app.

Before testing, the item must be buyable in staging: reviewed, activated by
the owner, and the staging Game live ("How an item becomes buyable").
Walk through every outcome:

- decline the sheet;
- buy with too few Sparks;
- buy a unique item you already own: `already_owned`, nothing charged;
- buy, then kill the game while the purchase is pending and relaunch: the result must arrive exactly once.

## Checklist

- [ ] Local Play: the shop button is hidden, and there are no script errors.
- [ ] Local Play with the fixture: `items.refresh()` succeeds, the owned item is listed, `equip` is accepted for it and refused with `not_owned` for anything else.
- [ ] Game code names items by slug, or by each environment's definition ids where slugs are not available.
- [ ] No code path creates an item, sends a price, or grants an item from a checkout status.
- [ ] Buy is disabled while `has_pending_checkouts()` is true, and for owned unique items.
- [ ] `manual_review` shows "confirming", and `already_owned` shows "Owned".
- [ ] Every `summer.items.json` sync: the dry-run plan was shown, then confirmed, then the owner got the approval link.
- [ ] Every new or changed item: Summer approved it, the owner pressed Review activation, and the Game is live.
- [ ] Staging: a purchase shows up in the inventory, and the equipped item appears for every player.

## Common mistakes

| Don't | Do | Why |
| --- | --- | --- |
| Create or grant items from game code | Define them in Studio, or in `summer.items.json` synced with `summer_sync_items` | Items are reviewed, and the owner approves every change |
| Hard-code definition ids | Match by slug | Definition ids differ between staging and production |
| Assume slug getters work everywhere | Check the Summer version; fall back to definition ids without them | 0.7.3 and older lack them; an item without an Item key reads `""` |
| Tell the owner an approved sync plan is on sale | Say each item still needs Summer's review, Review activation, and a live Game | Approving the plan only creates or revises the items |
| Confirm a sync without showing the plan | Dry run, show it, then `confirm` | The plan is what the owner approves |
| Treat `already_owned` as an error | Show "Owned" | A unique item is one per player |
| Unlock on `purchased` | Unlock from `Summer.client.items` | Ownership lives in the inventory; receipts can replay |
| Let the client tell the authority what it owns | `Summer.authority.items.inventory_for_session(session)` | Client claims are what cheaters forge |
| Send prices or amounts | Offer id + quantity only | The platform prices every purchase |
| Call `request_checkout` again on a slow result | Wait for its status; check `is_outcome_unknown()` | The first request may already be charged |
| Connect the status signal deferred or after reading statuses | Connect normally, first | Deferred handlers don't count as delivered; statuses can be missed |
| Treat `manual_review` as failed | Show "confirming" | The platform hasn't decided yet |
| Invent your own paid currency | Sell Summer items for Sparks | Summer can only protect, refund and pay out Sparks purchases |
| Assume the shop exists everywhere | Check readiness, hide when unavailable | Local Play, guests and older Summer apps have no store |

## See also

- `multiplayer-state`: Commands and the match document used for equipped items
- `multiplayer-testing`: Local Play fixtures and personas
- `summer-player-data`: saving a player's loadout between matches
- `summer-analytics`: measuring the shop

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@4.9.0` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_sync_items` | `summer economy sync-items` |
| `summer_get_diagnostics` | `summer engine get-diagnostics` |
| `summer_get_script_errors` | `summer engine get-script-errors` |
| `summer_play` | `summer engine play` |
| `summer_project_setting` | `summer engine project-setting` |
| `summer_run_script` | `summer engine run-script` |
| `summer_stop` | `summer engine stop` |
| `store.get_listing` | `summer store get-listing` |
| `store.publish` | `summer store publish` |
| `store.set_bundles` | `summer store set-bundles` |
| `store.set_sales` | `summer store set-sales` |
| `studio.open` | `summer studio open` |
<!-- /shell-commands -->
