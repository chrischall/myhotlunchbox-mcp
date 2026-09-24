# myhotlunchbox-mcp

MCP server for [My Hot Lunchbox](https://www.myhotlunchbox.com) — read the
school lunch calendar, manage students, place and change orders, and track
deliveries and payments on a parent account.

> Developed and maintained by AI (Claude Code). Use at your own discretion.

## Install

```sh
npx myhotlunchbox-mcp
```

Or as a Claude Code plugin:

```sh
/plugin marketplace add chrischall/myhotlunchbox-mcp
/plugin install myhotlunchbox-mcp
```

## Configure

```sh
MYHOTLUNCHBOX_USERNAME=you@example.com
MYHOTLUNCHBOX_PASSWORD=…
```

That is the whole setup. The server performs a real server-side sign-in against
`ordernow.myhotlunchbox.com` (OAuth2 password grant) and renews the session with
the refresh token it receives — **no browser extension, no signed-in tab, no
captured cookie**. Nothing is written to disk.

`MYHOTLUNCHBOX_BASE_URL` overrides the app origin if it ever moves.

The server boots without credentials so a host's install-time `tools/list` probe
still works; the configuration error surfaces on the first tool call.

## Tools

35 tools, all prefixed `mhlb_`. All 20 read tools are verified live against a real parent account (`node scripts/verify-reads.mjs`); the 14 write tools are not — see below.

The read claim carries a date because it can go stale with no tool file
touched: an SDK or `zod` major re-plumbs every read path underneath it. Last
re-run 2026-09-19 on 1.0.0 — the tree after the MCP SDK v2 migration and the
forced `zod` 4.6.2 bump — 20/20 green.

**Account** — `mhlb_whoami`, `mhlb_session_reset`

**Health** — `mhlb_healthcheck` (is this connector working? reports whether the credential resolved, whether My Hot Lunchbox accepted it, and what to fix — unlike `mhlb_whoami`, which throws instead of answering)

**Students** — `mhlb_list_students`, `mhlb_get_student_form`,
`mhlb_new_student_form`, `mhlb_create_student`, `mhlb_update_student`,
`mhlb_delete_student`

**Calendar** — `mhlb_get_calendar`, `mhlb_get_day`

**Ordering** — `mhlb_get_cart`, `mhlb_get_cart_tabs`, `mhlb_get_menu`,
`mhlb_get_order_form`, `mhlb_get_order`, `mhlb_create_order`,
`mhlb_update_order`, `mhlb_delete_order`

**Billing** — `mhlb_list_transactions`, `mhlb_get_transaction`,
`mhlb_list_subscriptions`, `mhlb_get_subscription_settings`,
`mhlb_set_subscription_enabled`, `mhlb_unsubscribe_order`,
`mhlb_list_gift_cards`, `mhlb_apply_gift_card`, `mhlb_get_coupon`,
`mhlb_apply_coupon`, `mhlb_remove_coupon`. `mhlb_list_gift_cards` masks each code to its
last 4 characters (a code is redeemable money); pass `revealCodes: true` for
the full code.

**Checkout** — `mhlb_init_checkout`, `mhlb_checkout`

**Reports** — `mhlb_print_calendar`, `mhlb_print_orders`,
`mhlb_print_transaction`. These return real PDFs; each writes the file and
returns its path, or the bytes inline with `inline: true`. Set
`MYHOTLUNCHBOX_OUTPUT_DIR` to choose where they land (defaults to the working
directory); existing files are never overwritten.

## Confirmations

Every mutating tool asks you to confirm before it sends anything. On a client
that can show a confirmation prompt (Claude Code) you get the prompt, with the
exact request the tool would send. On a client that cannot (claude.ai, Claude
Desktop), the first call makes **no** network call: it returns a preview of
exactly what it would send plus a `confirmToken`, and only a repeat call with
the same arguments and that token goes through. A token is single-use, and
changing any argument between the two calls is refused (`DRAFT_CHANGED`).

| variable | default | |
|---|---|---|
| `MCP_CONFIRM_MODE` | `ask-user` | What a write does on a client that cannot show a confirmation prompt (claude.ai, Claude Desktop). `ask-user`: two steps — the first call does nothing and returns a preview plus a token, and the model must get your approval in chat before calling again with it. `auto`: the same two steps, but the model may use the token after reviewing the preview itself. `refuse`: writes are refused on such clients. A client that can show prompts (Claude Code) always gets the real prompt. An unrecognised value is treated as `refuse`. |
| `MCP_CONFIRM_TTL_SECONDS` | `600` | How long a token stays valid. |
| `MCP_CONFIRM_SECRET` | random per process | Signing key; set it only if tokens must survive a server restart. |

`mhlb_checkout` charges a real payment method. The server prices the charge from
`orderIds`, so nothing client-side can bind the amount — there is no total in the
request to check against. `expectedTotal` is therefore **attribution, not a
guard**: you state what you expected, and it is shown in the confirmation
preview (and bound into its token) and returned in the result so an unexpected charge is traceable to the call that made it. What
the tool does refuse outright is paying a non-zero total with no `orderIds`.

### Writes: shapes captured, acceptance unverified

`npm run capture:writes` runs every mutating tool against a local proxy that
forwards reads to the real service but answers writes itself, so the payloads
are built from genuine server models and nothing happens upstream. It also
proves all 13 send nothing until they are confirmed with a `confirmToken`.

What that established, and corrected: `mhlb_delete_order` and
`mhlb_unsubscribe_order` take `{orderId, eventDate, studentId, isRepeated,
isSubscribed}` — not the order model — and checkout takes
`{orderIds, checkoutType, couponCode, giftCardCode, schoolDonations}`.

**What is still unverified is whether the server accepts these bodies.** Shape
is not acceptance; only a real write shows that, and none has been made. Inspect
the confirmation preview before approving it, and re-read afterwards — a `200` is not
proof a write persisted.

Two limits on `mhlb_checkout` specifically:

- It can only pay with a card **already saved** on the account. Paying with a
  new card needs a Stripe token minted by Stripe.js in a browser, which no
  server-side client can produce.
- It generates an idempotency key (unless you pass one) and returns it with the
  result and with any error. If a checkout fails ambiguously, retry with that
  same `idempotencyKey` rather than a fresh call — that is what stops a retry
  becoming a second charge. A key you pass yourself must be the same on both
  confirmation calls.

## Ordering is read-modify-write

There is no "add item X" call. Fetch the model, edit it, send it back whole:

1. `mhlb_get_menu` — what is orderable for a student on a date
2. `mhlb_get_order_form` — the order model to fill in
3. `mhlb_create_order` — send it back (and confirm the preview)
4. `mhlb_init_checkout` → `mhlb_checkout` — price, then pay

Fields omitted from the payload are **cleared**, not preserved.

## Shell skill

`skills/myhotlunchbox` covers the same account from a shell with `curl` — no MCP
process needed. Useful in scripts, or on a machine where this server is not
installed.

## Notes

- `/deliveryInfo/*` and `/calendar/viewMatchedVendors` look parent-facing in the
  compiled client but return `403` for a parent account — they belong to the
  school/vendor dashboards. No tool wraps them.
- Only the parent role is wired. The same API also serves school-admin and
  vendor roles; those endpoints return `403`, which the client reports as a role
  mismatch rather than a broken session.
- `docs/MYHOTLUNCHBOX-API.md` records how the API was mapped and exactly what is
  verified. `docs/api-surface.txt` is the full 359-endpoint extraction.

## Licence

MIT
