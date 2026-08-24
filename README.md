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

34 tools, all prefixed `mhlb_`. Every read path is verified live against a real parent account.

**Account** — `mhlb_whoami`, `mhlb_session_reset`

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
`mhlb_apply_coupon`, `mhlb_remove_coupon`

**Checkout** — `mhlb_init_checkout`, `mhlb_checkout`

**Reports** — `mhlb_print_calendar`, `mhlb_print_orders`,
`mhlb_print_transaction`. These return real PDFs; each writes the file and
returns its path, or the bytes inline with `inline: true`. Set
`MYHOTLUNCHBOX_OUTPUT_DIR` to choose where they land (defaults to the working
directory); existing files are never overwritten.

## Writes are confirm-gated

Every mutating tool takes `confirm`. Without `confirm: true` it makes **no**
network call and returns a dry-run preview of exactly what it would send.

`mhlb_checkout` charges a real payment method, so it takes one extra safeguard:
an `expectedTotal` that must match the total in the payment payload. Price the
cart with `mhlb_init_checkout`, read the total it reports, and pass that figure.
A stale cart fails closed instead of paying a different amount.

### Unverified writes

The write endpoints' paths, verbs and query parameters were extracted from the
site's own compiled API client and are reliable. Their **request bodies have not
been exercised against a live account** — every such tool says so in its
description. Inspect the dry-run preview before confirming, and re-read the
resource afterwards: a `200` is not proof a write persisted.

## Ordering is read-modify-write

There is no "add item X" call. Fetch the model, edit it, send it back whole:

1. `mhlb_get_menu` — what is orderable for a student on a date
2. `mhlb_get_order_form` — the order model to fill in
3. `mhlb_create_order` — send it back (with `confirm: true`)
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
