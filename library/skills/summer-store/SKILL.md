---
name: summer-store
description: "Sell Summer items for Sparks in a multiplayer game: shop, checkout, owned items, authority entitlement checks."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Edit Write summer_get_script_errors summer_project_setting summer_play summer_stop summer_get_diagnostics
paths: ["**/*.gd", ".summer/test-users.json"]
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

Three ids, kept apart:

| Id | Where it comes from | Use it for |
| --- | --- | --- |
| Offer id | `item.price.offer_id` in the store listing | `SummerCheckoutLine.create(offer_id, quantity)` |
| Definition id | Your item definition in the Summer catalog | "Does this player own a hat?" |
| Owned item id | One owned copy (`item.get_owned_item_id()`) | Pointing at a specific owned copy |

The rule that makes it cheat-proof: **the authority decides what a player may
use by reading that player's inventory itself.** A client saying "I bought it"
proves nothing.

**What runs where:**

| Surface | Store and checkout | Inventory |
| --- | --- | --- |
| Hosted | Need the Summer app's `player.store.read@1` / `player.store.checkout@1` | Needs `player.items@1` |
| Local Play | `unavailable` | Works from a fixture: empty unless `.summer/test-users.json` lists item templates (step 5) |
| Guests, older Summer apps | Readiness reports `unavailable` | Readiness reports `unavailable` |

Items and offers are created in your game's Studio pages (`summer_open` target
`game`). Code never creates items.

This skill extends the Courtyard game from `skill/multiplayer-project` and
`skill/multiplayer-state`.

## Steps

### 1. The client shop

`client/shop.gd`, a child `Shop` of `Main`. In `client/main.gd`'s `_ready()`, call
`$Shop.start()` right after `Summer.initialize` succeeds:

```gdscript
extends Node
## A shop for Summer items, paid in Sparks. Summer shows its own purchase
## sheet; the game never sees money and never grants an item itself.

signal shelf_changed(rows: Array)          # [{name, sparks, offer_id}]
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
			rows.append({"name": item.name, "sparks": item.price.sparks_amount, "offer_id": item.price.offer_id})
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
	if view.submission_failure != null:
		status.emit("The purchase did not start: %s" % view.submission_failure.code)


## Ownership comes only from the inventory, never from a checkout result.
func owns(definition_id: String) -> bool:
	return items.is_projection_loaded() and items.has_owned_definition(definition_id)


func _on_items_changed() -> void:
	status.emit("Inventory updated.")
```

Bind `checkouts_changed` to the Buy buttons: disable them while `busy` is
true. Update rows by `id`; a status can be delivered again after a crash, so
rendering must be idempotent. Show each checkout state:

| `state` | Show |
| --- | --- |
| `awaiting_approval`, `pending` | "Waiting for Summer…" |
| `purchased` | "Bought!" The item arrives through the inventory signals, possibly a moment later |
| `declined`, `expired` | Nothing, or "Cancelled" |
| `rejected` with `error_code` `insufficient_funds` | "Not enough Sparks" (players get Sparks in the Summer app) |
| `rejected`, other codes | "The purchase was not completed" |
| `manual_review` | "We're confirming this purchase." Not done, not failed |

### 2. Unlock from the inventory only

Unlock cosmetics in menus with `owns(definition_id)`, and refresh the menu on
`refreshed`, `item_replaced` and `item_removed`. Never unlock from a
`purchased` status: the receipt proves the debit, the inventory proves
ownership, including after a reinstall or on another device. An empty inventory
before `is_projection_loaded()` is "still loading", not "owns nothing".

### 3. The authority checks entitlement

Anything that changes the match because of an item goes through a Command, and
the authority reads that Session's inventory. Add `"equip"` to the `match` in
`authority/main.gd`'s `_on_command`:

```gdscript
		"equip":
			_equip(request, str(command.get("definition", "")))
```

```gdscript
## A player asks to wear a hat. The authority reads that Session's inventory
## itself; a client saying "I own it" proves nothing.
func _equip(request: SummerNetworkCommandRequest, definition_id: String) -> void:
	var session := request.get_session()
	var read := Summer.authority.items.inventory_for_session(session)
	var result: SummerResult = await read.get_result_or_completed_signal()
	if not result.ok:
		request.refuse(&"inventory_unavailable")   # retryable: try again later
		return
	for item in read.items:
		if item.is_owned() and item.get_definition_id() == definition_id:
			var hats: Dictionary = match_doc.get("hats", {})
			hats[session.player.user_id] = definition_id
			match_doc["hats"] = hats
			match_group.reset(Game.pack(match_doc))
			request.accept({}, Game.pack({"equipped": definition_id}))
			return
	request.refuse(&"not_owned")
```

The client sends `await command({"c": "equip", "definition": definition_id})`
and every client draws hats from `match_doc.hats`. Other players see the hat
only because the authority published it.

`Summer.authority.items.inventory_changed(session, change)` hints that a
player's inventory changed during the match. To drop an item that was
refunded mid-match, re-read with `inventory_for_session` (or
`refresh_inventory`) on that hint.

### 4. Rules and why

- **Offer ids and quantities only.** Never send a price, an amount or a buyer. The platform prices everything, and a client-side price is what a cheater edits.
- **One `request_checkout` is one purchase.** Each call gets a new identity. Never call it again because a result is slow; `is_outcome_unknown()` means it may already be charged, and the status will still arrive.
- **Connect `checkout_status_changed` normally, before reading statuses.** A synchronous handler is how the SDK knows the result was delivered; a deferred-only handler leaves it undelivered.
- **`pending` and `manual_review` are not failures.** Don't show success or failure until a terminal state.
- **Carts:** 1–16 different offers, at most 64 units, as one atomic purchase.
- **Hide what's unavailable.** `check_browse_readiness()` and `check_checkout_readiness()` return a `SummerResult`; show the shop only when they're `ok`.

### 5. Test

**Local Play.** The store and checkout report `unavailable`, so the hidden-shop
path is what you test. Inventory and the authority check work from a fixture:
create `.summer/test-users.json` with item templates.

```json
{
  "schema": "summer.local-fixture.v1",
  "fixture_id": "courtyard",
  "fixture_version": 1,
  "seed": 1,
  "world_definition": "world.json",
  "service_outcomes": [],
  "catalog_item_templates": ["hat"],
  "personas": [
    {"persona_id": "alice", "display_name": "Alice", "participant_role": "player", "eligible_for_outcome": true, "session_lifetime": "match_bound"},
    {"persona_id": "bob", "display_name": "Bob", "participant_role": "player", "eligible_for_outcome": true, "session_lifetime": "match_bound"}
  ]
}
```

What the fixture gives you:

- Every persona owns one item per template.
- Ids are local stand-ins. Bob's hat has owned item id `local-item:bob:0`, definition id `local-definition:courtyard:0`, and `item_template_version_id` `"hat"`.
- A check against your real catalog definition id is therefore `false` in Local Play. To exercise the authority path locally, equip with the local definition id the client reads from `items.get_owned_items()`.

**Staging.** Test real purchases there; Summer staging uses sandbox payments.
Walk through every outcome:

- decline the sheet;
- buy with too few Sparks;
- buy, then kill the game while the purchase is pending and relaunch: the result must arrive exactly once.

## Checklist

- [ ] Local Play: the shop button is hidden, and there are no script errors.
- [ ] Local Play with the fixture: `items.refresh()` succeeds, the owned item is listed, `equip` is accepted for it and refused with `not_owned` for anything else.
- [ ] No code path sends a price or grants an item from a checkout status.
- [ ] Buy is disabled while `has_pending_checkouts()` is true.
- [ ] `manual_review` shows "confirming", not success or failure.
- [ ] Staging: a purchase shows up in the inventory, and the equipped item appears for every player.

## Common mistakes

| Don't | Do | Why |
| --- | --- | --- |
| Unlock on `purchased` | Unlock from `Summer.client.items` | Ownership lives in the inventory; receipts can replay |
| Let the client tell the authority what it owns | `Summer.authority.items.inventory_for_session(session)` | Client claims are what cheaters forge |
| Send prices or amounts | Offer id + quantity only | The platform prices every purchase |
| Call `request_checkout` again on a slow result | Wait for its status; check `is_outcome_unknown()` | The first request may already be charged |
| Connect the status signal deferred or after reading statuses | Connect normally, first | Deferred handlers don't count as delivered; statuses can be missed |
| Treat `manual_review` as failed | Show "confirming" | The platform hasn't decided yet |
| Invent your own paid currency | Sell Summer items for Sparks | Summer can only protect, refund and pay out Sparks purchases |
| Assume the shop exists everywhere | Check readiness, hide when unavailable | Local Play, guests and older Summer apps have no store |

## See also

- `skill/multiplayer-state`: Commands and the match document used for equipped items
- `skill/multiplayer-testing`: Local Play fixtures and personas
- `skill/summer-player-data`: saving a player's loadout between matches
- `skill/summer-analytics`: measuring the shop
