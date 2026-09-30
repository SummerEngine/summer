---
name: in-game-purchases
description: "Sell items for Sparks and let short players buy Sparks in game via the Summer purchase sheet: checkout, Sparks purchase, results, testing, store policy."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: gameplay
allowed-tools: Read Grep Write summer_get_script_errors summer_get_scene_tree
paths: ["**/*.gd"]
---

# In-game purchases with Sparks

Sparks are Summer's currency. A game never takes money, never holds a
balance and never approves a payment. It asks Summer, Summer shows its own
purchase sheet over the game, and the game reacts to the authoritative
result. There are two calls and they follow the same shape:

| The player wants to | Call | Validated by |
| --- | --- | --- |
| buy an item with Sparks they have | `Summer.client.store.request_checkout(lines)` | the Summer ledger (debit) |
| buy Sparks because they are short | `Summer.client.store.request_sparks_purchase(minimum_sparks)` | the payment provider (Stripe or Apple), then the ledger credit |

## When to sell with Sparks

- Sell anything that persists across sessions or devices (cosmetics, unlocks,
  passes) as a Summer item with a Sparks price. *Why:* the platform owns the
  item, so ownership survives reinstalls and cannot be forged by editing the
  game.
- Do not invent your own currency that is bought with money. *Why:* Summer
  can only refund, protect and pay you out for Sparks purchases.
- Offer "Get Sparks" only when a purchase failed for lack of Sparks, or on an
  explicit shop button. *Why:* the Summer sheet interrupts play; surprise
  payment prompts read as pressure and get games reported.

## Rules and the reason for each

1. **Never grant an item from a button press or a receipt.** Unlock only when
   `Summer.client.items` shows the player owns it. *Why:* the receipt proves
   the debit; the inventory projection is what the platform guarantees the
   player owns, including after a crash or on another device.
2. **Never send prices, amounts or providers.** The game passes an offer ID
   and a quantity, or a Sparks hint. *Why:* the platform prices everything; a
   client-supplied price is exactly what a cheater edits.
3. **One call is one purchase.** Every call creates a new identity. Never
   call again to "retry" an unknown outcome. *Why:* the first request may
   already be charged; the SDK and the Summer app recover it and deliver the
   result on the signal.
4. **Handle results only in the status signals, and deduplicate by
   `request_id` plus `version`.** Connect normally (not deferred) before
   requesting. *Why:* results can arrive after a restart or twice after a
   crash; a synchronous handler is how the SDK knows the result was delivered.
5. **Treat `manual_review` and pending as not done.** *Why:* the platform
   has not decided yet; showing success or failure would be a guess.
6. **Check readiness and hide what is unavailable.**
   `check_checkout_readiness()` and `check_sparks_purchase_readiness()` return
   a `SummerResult`. *Why:* editor play, guest sessions and older Summer apps
   do not offer purchases; a dead button is worse than no button.

## Result states

Both signals deliver a status with `state`:

| State | Meaning | What the game does |
| --- | --- | --- |
| `awaiting_approval` | the Summer sheet is open | nothing; optionally dim the shop |
| `pending` | payment or debit in progress | show "processing" |
| `purchased` | done; Sparks debited (checkout) or credited (Sparks) | checkout: refresh items and unlock from inventory. Sparks: say "Sparks added", let the player buy again |
| `declined` | the player closed the sheet | return to the shop quietly |
| `expired` | the sheet or payment timed out | same as declined |
| `rejected` | refused; read `error_code` | checkout with `insufficient_funds`: offer "Get Sparks". Sparks: `provider_rejected`, say the payment did not go through |
| `manual_review` | platform is checking it | "We are confirming this purchase" |
| `refunded` | Sparks only: a credited purchase was refunded or charged back (`full_refund`, `dispute_lost`) | nothing to undo; Summer already took the Sparks back. Refresh any balance display |

A Sparks request can also fail to start with `purchase_limit` (the player
reached the daily in-game Sparks limit) or `age_required` / `adult_required`
(only adults with a saved age can buy Sparks). Show a short message and no
retry button. *Why:* both limits are platform policy; retrying changes nothing.

The operation returned by each call also completes (`completed` signal) on
`purchased` (ok) or a terminal failure with codes such as `checkout_declined`
or `sparks_purchase_declined`. The status signal is the one to build UI on.

## Minimal complete example

```gdscript
extends Node
## A one-item shop. Buys `offer_id`; if the player is short, lets them buy
## Sparks through the Summer sheet, then they press Buy again.

@export var offer_id := "offer_sword"
@export var definition_id := "item_sword"
@export var price_sparks := 250 # display only; the platform charges its own price

signal message(text: String)
var _seen := {}

func _ready() -> void:
	var store := Summer.client.store
	store.checkout_status_changed.connect(_on_checkout)
	store.sparks_purchase_status_changed.connect(_on_sparks)
	Summer.client.items.refreshed.connect(_sync_owned)
	_sync_owned()

func buy() -> void:
	if not Summer.client.store.check_checkout_readiness().ok:
		message.emit("The shop is not available here.")
		return
	var lines: Array[SummerCheckoutLine] = [SummerCheckoutLine.create(offer_id, 1)]
	Summer.client.store.request_checkout(lines) # result arrives in _on_checkout

func get_sparks() -> void:
	if not Summer.client.store.check_sparks_purchase_readiness().ok:
		message.emit("Get Sparks from the Summer app.")
		return
	Summer.client.store.request_sparks_purchase(price_sparks) # hint only

func _first_time(status) -> bool:
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
				message.emit("Not enough Sparks.") # show a Get Sparks button -> get_sparks()
			else:
				message.emit("The purchase was not completed.")
		&"manual_review":
			message.emit("We are confirming this purchase.")
		&"declined", &"expired":
			pass

func _on_sparks(status: SummerSparksPurchaseStatus) -> void:
	if not _first_time(status):
		return
	match status.state:
		&"purchased":
			message.emit("%d Sparks added." % status.receipt.sparks_credited)
		&"rejected":
			message.emit("The payment did not go through.")
		&"manual_review":
			message.emit("We are confirming your payment.")

func _sync_owned() -> void:
	if Summer.client.items.has_owned_definition(definition_id):
		message.emit("Sword unlocked.") # the only place the item is granted
```

After Sparks are added the player presses Buy again. That is a new checkout
and Summer shows it again. *Why:* the player confirms each spend separately.

## Multiplayer: granting an effect on a dedicated authority

Buying Sparks only adds Sparks to the wallet. Anything the Sparks buy
("Grow now", "Summon rain") is a separate checkout, and on a server the
authority must never grant it because a client says it paid. *Why:* a client
message is the one thing a cheater controls.

Model the effect as a consumable catalog item with instance ownership (each
purchase is a separate item, not a stack). *Why:* a stackable (quantity) item
shares one owned item ID across purchases, so the ID could not tell two
purchases apart. The client checks out; the receipt's `owned_item_ids` are item
instances in the player's Summer inventory. The client sends the authority
only the request ID and that owned item ID. The authority reads the player's
Session inventory through the Summer items authority
(`inventory_for_session`) and applies the effect only if that item exists,
belongs to that player and has the right definition. It records the owned item
ID in its world save before applying, and ignores an ID it already recorded.
*Why:* the platform inventory is the only proof the purchase happened, and the
recorded ID makes a retry or a replayed message grant once.

```gdscript
# On the dedicated authority. `redeemed` is saved with the world.
func redeem(session: SummerSession, owned_item_id: String) -> void:
	if redeemed.has(owned_item_id):
		return # a retried or replayed message grants once
	var op := Summer.authority.items.inventory_for_session(session)
	var result: SummerResult = await op.get_result_or_completed_signal()
	if not result.ok:
		return # refuse for now; the client may ask again later
	for item in op.items:
		if item.item_id == owned_item_id and item.state == &"owned":
			redeemed[owned_item_id] = true # record before applying, then save
			apply_grow_now(session)
			return
```

Not yet available: consuming the item from the authority, so the same item
could be redeemed again in a different world. Until the authority consume
operation ships, keep such effects scoped to one persistent world, or refuse
them on a dedicated authority, as Grow Your Garden does.

## Idempotency

The SDK generates the request ID and replays it across transport failures and
app restarts; the platform credits a Sparks purchase once per provider
transaction and debits a checkout once per request. Your only job is the
`request_id:version` dedupe above, so a replayed signal does not show a
message or play an effect twice.

## Per-surface behaviour

- **Summer Games app on iOS:** a native Summer sheet over the game. Sparks are
  bought with Apple In-App Purchase only.
- **Summer desktop app:** an overlay sheet; Sparks are paid with Stripe in the
  browser, and the result returns to the game on the signal.
- **Web:** the same sheet in the page, paid with Stripe.
- **Editor play and local runs:** readiness is `unavailable`. Build the
  unavailable path first.

The game code is identical on every surface.

## Testing

- Test against Summer staging, which runs payments in sandbox mode: Stripe
  sandbox cards on web and desktop, an Apple Sandbox tester account on iOS test
  builds. *Why:* no real money moves and results are identical to production.
- Walk every state: decline the sheet, let it expire, buy with too few
  Sparks, buy Sparks, then buy the item. Kill the game while a payment is
  pending and relaunch; the result must still arrive once.
- Verify the unlock comes from `items.refreshed`, not from the checkout
  signal.

## Store policy notes

- Apple requires In-App Purchase for digital goods and currency sold inside
  iOS apps. Summer's iOS sheet handles this; never add your own payment links,
  web prices or "cheaper on the web" text inside the game. *Why:* it can get
  the Summer app removed from the App Store for every game.
- Randomized paid rewards must disclose their odds before purchase (Apple and
  most regions require it).
- Say what a purchase gives in plain words next to the price.

## Availability

`request_checkout` ships today. `request_sparks_purchase` needs a Summer
Engine and Summer app release that advertise `player.store.sparks_purchase@1`;
until then `check_sparks_purchase_readiness()` reports `unavailable` and the
example above falls back to "Get Sparks from the Summer app".

## See also

- host-authoritative-state
- ui-basics
