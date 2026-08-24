# My Hot Lunchbox API

How this was derived, what is verified, and what is not.

## Surface

| | |
|---|---|
| App | `https://ordernow.myhotlunchbox.com` (Vue 2 + Vite SPA) |
| API base | `/api` (the SPA's axios `baseURL`) |
| Auth | OAuth2 **password grant**, OpenIddict (ASP.NET Core) |
| Marketing site | `https://www.myhotlunchbox.com` — WordPress, unrelated, no API |

`www.` and `ordernow.` are different applications. Only `ordernow.` serves the API.

## Authentication — verified

The web app performs a real server-side password grant. There is **no bot wall**
(a plain `curl` from a datacentre IP reaches the origin and gets a clean `401`),
**no CAPTCHA** (the compiled bundle contains no reCAPTCHA / hCaptcha / Turnstile
/ Arkose reference), and **no browser bridge is required** at any point.

```
POST /api/auth/login
Content-Type: application/x-www-form-urlencoded

grant_type=password
username=<email>
password=<password>
scope=openid offline_access email profile roles
```

Response: `{ access_token, refresh_token, expires_in, token_type }`.

Renewal uses the same endpoint:

```
grant_type=refresh_token
refresh_token=<token>
```

Authenticated calls send `Authorization: Bearer <access_token>`.

`offline_access` is what yields the refresh token — drop it and the session
cannot be renewed without the password again.

### Verified by probe

A single probe with a deliberately nonexistent `@example.com` address returned:

```json
{
  "error": "invalid_grant",
  "error_description": "Username and Password combination is not recognized.",
  "error_uri": "https://documentation.openiddict.com/errors/ID2024"
}
```

The client identity was **accepted** — endpoint, grant type, scope and encoding
are all correct; only the credential was wrong. That is what establishes this as
a server-side-auth archetype rather than a browser-bridge one.

> Never retry a rejected credential. OpenIddict deployments commonly count
> failed attempts and escalate to a CAPTCHA, which would permanently remove the
> only server-side auth path for that account.

## How the endpoint surface was extracted

The SPA code-splits into 584 Vite chunks, all publicly fetchable without auth.
Each service module is a thin wrapper of the form:

```js
async childrenInfoData() { return (await axios.get("/parent/childrenInfo")).data }
async editChildData(a)   { return (await axios.get("/parent/editChild", { params: { childId: a } })).data }
async editChild(a)       { return (await axios.post("/parent/editChild", a)).data }
```

so verb, path and query-parameter names come out mechanically. `docs/api-surface.txt`
holds the full extraction: **359 endpoints across 22 prefixes**.

There is no OpenAPI document — `/swagger`, `/swagger/v1/swagger.json`,
`/openapi.json` and `/api-docs` all return the SPA's `index.html`.

## Prefixes

Reachable by a parent account:

| Prefix | n | Contents |
|---|---|---|
| `/auth` | 3 | login, userinfo |
| `/parent` | 17 | students, gift cards, coupons, subscription toggle |
| `/calendar` | 11 | lunch calendar, per-day order items, matched vendors |
| `/event` | 39 | cart, order create/edit/delete, transactions, subscriptions |
| `/payment` | 5 | `initCheckout`, `checkout` (Stripe), treats |
| `/deliveryInfo` | 8 | next / upcoming / archived deliveries |
| `/parentReports` | 4 | printable PDFs |
| `/ajax` | 50 | shared lookups (schools, grades, teachers, tax rates) |

Not reachable by a parent account (present in the same bundle because the app
also serves school-admin and vendor roles): `/school`, `/schoolManagement`,
`/schoolOnboarding`, `/vendor`, `/vendorReports`, `/schoolVendorReports`,
`/item`, `/adminTasks`, `/quickbooks`, `/docusign`,
`/interactiveDistributionReport`, `/upload`.

These answer `403`; the client maps that to an explicit role-mismatch error
rather than a generic failure.

## Read-modify-write

Ordering and student editing are **not** field-by-field APIs. Each is a pair:

| Read (returns a populated model) | Write (takes that model back) |
|---|---|
| `GET /event/createOrder?eventId&studentId` | `POST /event/createOrder` |
| `GET /event/editOrder` | `POST /event/editOrder` |
| `GET /parent/createChild` | `POST /parent/createChild` |
| `GET /parent/editChild?childId` | `POST /parent/editChild` |

The compiled client passes the model through opaquely — it never names the
fields — so the MCP does the same: read the model, edit it, send it back. The
writes are **whole-record replaces**: a field omitted from the payload is
cleared, not preserved.

Field names observed in the order model: `studentId`, `eventId`, `eventItemId`,
`quantity`, `isRepeated`, `orderItemStatus`, `totalPrice`.

## Verification status

**Verified live against a real parent account — all 20 read tools.** The auth
flow (probe above), the API base path, the absence of a bot wall and of a
CAPTCHA, and every read endpoint the server wires: `/auth/userinfo`,
`/parent/childrenInfo`, `/parent/createChild` (GET), `/parent/editChild` (GET),
`/calendar/studentSchoolData`, `/calendar/studentOrderItems`,
`/event/ShoppingCartBaseData`, `/event/shoppingCart`, `/event/orderBaseData`,
`/event/createOrder` (GET), `/event/editOrder` (GET),
`/event/transactionsList`, `/event/transactionDetails`,
`/event/upcomingSubscriptions`, `/event/subscription`,
`/parent/giftCardDataTables`, `/parent/coupon`, and all three
`/parentReports/print*` endpoints (each returning a real PDF).

`scripts/verify-reads.mjs` measures coverage against the tool roster, not
against the rows it happens to run, and exits non-zero on any failure. Rows that
depend on account state (a paid order, an existing transaction) are reported as
*not exercised* rather than silently counted.

### What live verification caught that the extraction did not

Four things, all of which would have shipped broken:

1. **`/calendar/studentSchoolData` takes `start`/`end`, not `startDate`/`endDate`.**
   The wrong field names return **HTTP 200 with an empty `events` array** — a
   silent wrong answer, not an error. Captured from the live app:
   `{"start":"2026-07-26","end":"2026-09-06"}`.

2. **The `/parentReports/print*` endpoints return binary PDF, not JSON.** The
   site's own client declares `responseType: 'blob'`; they stream
   `%PDF-1.4` from wkhtmltopdf. Parsing them as JSON throws on the first byte,
   so they need a separate client path (`MhlbClient.writeBinary`).

3. **Their payloads are not date ranges.**
   `printCalendar` takes `{start, end, middle, studentIds}` — `middle` is the
   midpoint date, used to title the PDF. `printOrders` takes
   `{orderStatus, eventDate, studentIds}` — a **single** date. **Both** require a
   **non-empty** `studentIds`: an empty or omitted list answers `500` on either
   endpoint (verified live). There is no "all students" default. It also answers `500`
   when no order matches the date and status, so a `500` here is usually a
   caller mistake dressed as a server fault. `printTransactions` takes a whole
   transaction record plus `isCreditType`, not a range.
   Order status enum: `Pending: 0, Paid: 1, Credited: 2`.

4. **Four endpoints classified as parent-facing are not.** `/deliveryInfo/nextDelivery`,
   `/deliveryInfo/upcomingDeliveries`, `/deliveryInfo/archivedDeliveries` and
   `/calendar/viewMatchedVendors` all return `403` for a parent account — they
   are reached from `school-calendar` and a different (school/vendor) dashboard
   chunk. The tools that wrapped them were removed rather than shipped dead.

**UNVERIFIED** — every write endpoint. Their paths, verbs and query parameters
come from the compiled client and are reliable; their **request bodies** have
not been exercised against a live account. Each corresponding tool carries the
same marker in its description and refuses to act without `confirm: true`,
returning a dry-run preview of exactly what it would send.

To flip a write to verified, exercise it, then update *all* of: this file, the
tool's description (`UNVERIFIED` in `src/tools/_shared.ts` is appended per tool),
the README, and the skill. Grep before declaring it done:

```sh
grep -rniE "unverified|not been exercised" README.md docs/ skills/ src/
```
