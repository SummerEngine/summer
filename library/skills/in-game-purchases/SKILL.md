---
name: in-game-purchases
description: "Sell items for Sparks via the Summer purchase sheet: checkout, results, unlocking from inventory, authority grants, testing, store policy."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: gameplay
allowed-tools: Read Grep Write summer_get_script_errors summer_get_scene_tree
paths: ["**/*.gd"]
---

# In-game purchases with Sparks

Sparks are Summer's currency. A game never takes money, never holds a
balance and never approves a payment. It asks Summer for a checkout, Summer
shows its own purchase sheet over the game, and the game reacts to the
authoritative result.

| The player wants to | Call | Validated by |
| --- | --- | --- |
| buy an item with Sparks they have | `Summer.client.store.request_checkout(lines)` | the Summer ledger (debit) |
| buy Sparks because they are short | no game call: the player gets Sparks in the Summer app | the Summer app |

The engine has no call that sells Sparks from inside the game. When a
checkout fails with `insufficient_funds`, tell the player they need more
Sparks and that they can get them in the Summer app, then let them press Buy
again.

## When to sell with Sparks

- Sell anything that persists across sessions or devices (cosmetics, unlocks,
  passes) as a Summer item with a Sparks price. *Why:* the platform owns the
  item, so ownership survives reinstalls and cannot be forged by editing the
  game.
- Do not invent your own currency that is bought with money. *Why:* Summer
  can only refund, protect and pay you out for Sparks purchases.
- Open the shop only from an explicit shop or buy button. *Why:* the Summer
  sheet interrupts play; surprise payment prompts read as pressure and get
  games reported.

## Rules and the reason for each

1. **Never grant an item from a button press or a receipt.** Unlock only when
   `Summer.client.items` shows the player owns it. *Why:* the receipt proves
   the debit; the inventory projection is what the platform guarantees the
   player owns, including after a crash or on another device.
2. **Never send prices or amounts.** The game passes an offer ID and a
   quantity (`SummerCheckoutLine.create(offer_id, quantity)`). *Why:* the
   platform prices everything; a client-supplied price is exactly what a
   cheater edits.
3. **One call is one purchase.** Every `request_checkout` creates a new
   identity. Never call again to "retry" an unknown outcome
   (`SummerCheckoutOperation.is_outcome_unknown()`). *Why:* the first request
   may already be charged; the SDK recovers it and delivers the result on the
   signal.
4. **Handle results in `checkout_status_changed`, and deduplicate by
   `request_id` plus `version`.** Connect normally (not deferred) before
   requesting. To draw a checkout panel, read `get_checkout_statuses()` and
   `has_pending_checkouts()` instead of keeping your own list. *Why:* results
   can arrive after a restart or twice after a crash; a synchronous handler is
   how the SDK knows the result was delivered.
5. **Treat `manual_review` and `pending` as not done.** *Why:* the platform
   has not decided yet; showing success or failure would be a guess.
6. **Check readiness and hide what is unavailable.**
   `check_checkout_readiness()` (buying) and `check_browse_readiness()`
   (listing with `list_items()`) return a `SummerResult`. *Why:* editor play,
   guest sessions and older Summer apps do not offer purchases; a dead button
   is worse than no button.

## Result states

`checkout_status_changed(status: SummerCheckoutStatus)` delivers a status
whose `state` is one of:

| State | Meaning | What the game does |
| --- | --- | --- |
| `awaiting_approval` | the Summer sheet is open | nothing; optionally dim the shop |
| `pending` | the debit is in progress | show "processing" |
| `purchased` | done; Sparks debited, `status.receipt` is set | refresh items and unlock from inventory |
| `declined` | the player closed the sheet | return to the shop quietly |
| `expired` | the sheet timed out | same as declined |
| `rejected` | refused; read `error_code` | `insufficient_funds`: "Not enough Sparks. Get Sparks in the Summer app." Other codes: "The purchase was not completed." |
| `manual_review` | platform is checking it | "We are confirming this purchase" |

`status.is_terminal()` tells you whether the state can still change. Unknown
future `error_code` values never mean success.

The operation returned by `request_checkout` also completes: ok on
`purchased`, a failure otherwise. The status signal is the one to build UI on.

## Minimal complete example

```gdscript
extends Node
## A one-item shop. Buys `offer_id` and unlocks from inventory.

@export var offer_id := "offer_sword"
@export var definition_id := "item_sword"

signal message(text: String)
var _seen := {}

func _ready() -> void:
	if Summer.client == null:
		return # not running as a player's game
	Summer.client.store.checkout_status_changed.connect(_on_checkout)
	Summer.client.items.refreshed.connect(_sync_owned)
	_sync_owned()

func buy() -> void:
	if not Summer.client.store.check_checkout_readiness().ok:
		message.emit("The shop is not available here.")
		return
	var lines: Array[SummerCheckoutLine] = [SummerCheckoutLine.create(offer_id, 1)]
	Summer.client.store.request_checkout(lines) # result arrives in _on_checkout

func _first_time(status: SummerCheckoutStatus) -> bool:
	var key := "%s:%d" % [status.request_id, status.version]
	if _seen.has(key):
		return false
	_seen[key] = true
	return true

func _on_checkout(status: SummerCheckoutStatus) -> void:
	if not _first_time(status):
		return
	match status.state:
		&"purchased":
			Summer.client.items.refresh() # ownership comes from inventory
		&"rejected":
			if status.error_code == &"insufficient_funds":
				message.emit("Not enough Sparks. Get Sparks in the Summer app, then buy again.")
			else:
				message.emit("The purchase was not completed.")
		&"manual_review":
			message.emit("We are confirming this purchase.")
		&"declined", &"expired":
			pass

func _sync_owned() -> void:
	if Summer.client.items.has_owned_definition(definition_id):
		message.emit("Sword unlocked.") # the only place the item is granted
```

## Multiplayer: granting an effect on a dedicated authority

Anything the Sparks buy ("Grow now", "Summon rain") is a checkout for an
item, and on a server the authority must never grant it because a client says
it paid. *Why:* a client message is the one thing a cheater controls.

Model the effect as a catalog item with instance ownership (each purchase is a
separate owned item, not a stack). *Why:* a stackable item shares one owned
item ID across purchases, so the ID could not tell two purchases apart.

The client checks out; the receipt's `items[i].owned_item_ids` are the owned
items. The client sends the authority only an owned item ID. The authority:

1. reads that player's inventory with
   `Summer.authority.items.inventory_for_session(session)` and checks the
   item is there, owned, and of the right definition;
2. checks its own record of redeemed item IDs, kept in the player's secret
   player data (`Summer.authority.player_data`), so the item grants once per
   player in every world;
3. writes the new record, and applies the effect only after that write
   succeeds.

```gdscript
# On the dedicated authority.
const EFFECT_DEFINITION := "item_grow_now"

func redeem(session: SummerSession, owned_item_id: String) -> void:
	var inv := Summer.authority.items.inventory_for_session(session)
	var read: SummerResult = await inv.get_result_or_completed_signal()
	if not read.ok:
		return # unavailable: the client may ask again later
	var item: SummerInventoryItem = null
	for candidate in inv.items:
		if candidate.get_owned_item_id() == owned_item_id:
			item = candidate
	if item == null or not item.is_owned() or item.get_definition_id() != EFFECT_DEFINITION:
		return # not owned by this player: never grant

	var load_op := Summer.authority.player_data.load(session)
	var loaded: SummerResult = await load_op.get_result_or_completed_signal()
	if not loaded.ok:
		return
	var data: Dictionary = load_op.secret_record.data
	var redeemed: Dictionary = data.get("redeemed", {})
	if redeemed.has(owned_item_id):
		return # a repeated message grants once
	redeemed[owned_item_id] = true
	data["redeemed"] = redeemed
	var save_id := "redeem_" + owned_item_id.sha256_text().substr(0, 40)
	var commit := Summer.authority.player_data.commit_secret(session, save_id, data)
	var saved: SummerResult = await commit.get_result_or_completed_signal()
	if not saved.ok:
		return # retryable: commit again with the same save_id
	apply_grow_now(session)
```

- The save ID comes from the owned item ID. *Why:* resending the same save ID
  with the same content returns the earlier commit (`commit.replayed`), so a
  retry after a timeout records the redemption once.
- Apply the effect when the commit succeeds even if `commit.replayed` is true
  and the effect is not in your world yet. *Why:* a replay means the
  redemption was recorded earlier, but your world may have crashed before it
  applied the effect.
- The engine has no call that uses up an owned item. The item stays in the
  player's inventory after it is redeemed; the redeemed list is what stops a
  second grant. Show redeemed items as used in your UI.

## Idempotency

The SDK generates the checkout request ID and replays it across transport
failures and app restarts; the platform debits a checkout once per request.
Your only job is the `request_id:version` dedupe above, so a replayed signal
does not show a message or play an effect twice.

## Per-surface behaviour

- **Summer Games app on iOS:** a native Summer sheet over the game.
- **Summer desktop app:** an overlay sheet; the result returns to the game on
  the signal.
- **Web:** the same sheet in the page.
- **Editor play and local runs:** readiness is `unavailable`. Build the
  unavailable path first.

The game code is identical on every surface.

## Testing

- Test against Summer staging, which runs in sandbox mode. *Why:* no real
  money moves and results are identical to production.
- Walk every state: decline the sheet, let it expire, buy with too few
  Sparks, get Sparks in the Summer app, then buy the item. Kill the game while
  a checkout is pending and relaunch; the result must still arrive once.
- Verify the unlock comes from `items.refreshed`, not from the checkout
  signal.

## Store policy notes

- Apple requires In-App Purchase for digital goods and currency sold inside
  iOS apps. Summer's iOS sheet and app handle this; never add your own payment
  links, web prices or "cheaper on the web" text inside the game. *Why:* it
  can get the Summer app removed from the App Store for every game.
- Randomized paid rewards must disclose their odds before purchase (Apple and
  most regions require it).
- Say what a purchase gives in plain words next to the price.

## Availability

`request_checkout`, `list_items`, `Summer.client.items`,
`Summer.authority.items.inventory_for_session` and `Summer.authority.player_data`
ship in the engine today. Buying Sparks inside the game does not: players get
Sparks in the Summer app.

## See also

- multiplayer-state
- ui-basics
