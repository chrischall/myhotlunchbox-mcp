# myhotlunchbox-mcp

Repo-specific notes. Fleet-wide conventions live in `~/.claude/CLAUDE.md` and
are deliberately not restated here.

## Archetype

Server-side OAuth2 **password grant** — not a browser bridge, not a captured
cookie. `ordernow.myhotlunchbox.com` has no bot wall and no CAPTCHA, so
`MYHOTLUNCHBOX_USERNAME` + `MYHOTLUNCHBOX_PASSWORD` are the whole configuration.
Do not add a `@fetchproxy/server` dependency; nothing here needs one.

`offline_access` in the scope is load-bearing — it is what yields the refresh
token. Drop it and every session needs the password again.

## Never retry a rejected credential

`/api/auth/login` is OpenIddict. A failed attempt is counted, and repeated
failures can escalate to a CAPTCHA that removes server-side sign-in for the
account permanently. `MhlbAuth.postGrant` throws on the first rejection by
design — do not add a retry loop around it.

## The password has no shape

`redactSecrets` / `truncateErrorMessage` match secret *shapes* (Bearer, JWT,
`sk-`). A password matches none of them. Every error path that renders an
upstream body goes through `scrubCredentials(text, [password])`, which splices
the literal value out. `tests/auth.test.ts` and `tests/client.test.ts` assert the
**outcome** (the password is absent from the message), not that the wrapper was
called — the wrapper alone would have passed while still leaking.

## Ordering is read-modify-write

`GET /event/createOrder` returns a model; `POST /event/createOrder` takes it
back. Same for `editOrder`, `createChild`, `editChild`. The site's own compiled
client passes these through opaquely and never names the fields, so the tools do
the same rather than inventing a schema. These are whole-record replaces.

## Field names the extraction got wrong

Four things the compiled-client extraction could not tell us, all found by
running against a real account. Do not "simplify" any of them back:

- `/calendar/studentSchoolData` takes **`start`/`end`**, not `startDate`/`endDate`.
  Wrong names return **200 with an empty `events` array** — a silent wrong
  answer. `tests/tools.test.ts` pins this.
- `/parentReports/print*` return **binary PDF**, not JSON — hence
  `MhlbClient.writeBinary`. Their payloads are not date ranges:
  `printCalendar` needs `middle` (the midpoint date), `printOrders` takes a
  **single** `eventDate` plus a **non-empty** `studentIds`, and
  `printTransactions` takes a whole transaction record.
- `printOrders` answers **500**, not 4xx, for an empty `studentIds` or a date
  with no matching order. `writeBinary` words its 500 hint accordingly — do not
  replace it with a generic `UnreachableError`.
- Order status enum: `Pending: 0, Paid: 1, Credited: 2`.

`/deliveryInfo/*` and `/calendar/viewMatchedVendors` are **not** parent-role
(403, verified live) even though they sit in chunks the parent bundle loads.
Tools for them were removed; don't re-add them from the extraction.

Re-run `node scripts/verify-reads.mjs` (needs `.env`) after touching any read
path — it drives all 18 through the built client.

## Writes are unverified

Paths and verbs came from the compiled client and are reliable; request bodies
have not been exercised live. The marker lives in one place —
`UNVERIFIED` in `src/tools/_shared.ts` — and is appended per tool description.

Flipping any write to verified is a **tree-wide** edit, not a file edit:

```sh
grep -rniE "unverified|not been exercised" README.md docs/ skills/ src/
```

Update every hit in one pass.

## manifest.json's tool list is generated

`node scripts/gen-manifest.mjs` (after `npm run build`) regenerates it from the
tools the server actually registers. `tests/packaging.test.ts` asserts the two
match in both directions, so a hand-edit that drifts fails CI.

## Endpoint surface

`docs/api-surface.txt` is the full mechanical extraction — 359 endpoints across
22 prefixes, pulled from the SPA's 584 public Vite chunks. Only the parent-role
prefixes are wired. The rest return `403`, which `MhlbClient.parse` reports as a
role mismatch so it is not mistaken for a broken session.
