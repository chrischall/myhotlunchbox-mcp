# My Hot Lunchbox endpoints — ready-to-run

All paths are relative to `$MHLB/api`. All need `Authorization: Bearer $MHLB_TOKEN`.
Assumes the `mhlb_get` helper from `SKILL.md` is defined.

## Account

```sh
# Account claims: name, role, student count, credit balances, subscription state
mhlb_get /auth/userinfo | jq .
```

## Students

```sh
mhlb_get /parent/childrenInfo | jq '.[] | {id, firstName, schoolName, gradeTeacher, hasOrders, isInactive, isInvited}'

# Editable profile for one student (also the model that POST /parent/editChild takes back)
mhlb_get '/parent/editChild?childId=456' | jq .

# Blank profile + dropdown options for adding a student
mhlb_get /parent/createChild | jq .
```

## Calendar and deliveries

```sh
# Lunch calendar for a range — a POST that reads
mhlb_post() {
  local endpoint=$1; shift   # NOT `path`: zsh ties $path to $PATH
  curl -sS -X POST "$MHLB/api$endpoint" -H "Authorization: Bearer $MHLB_TOKEN" \
    -H 'Content-Type: application/json' -d "${1:-{\}}"
}

mhlb_post /calendar/studentSchoolData '{"startDate":"2026-09-01","endDate":"2026-09-30"}' | jq .

# What one student has on one day
mhlb_get '/calendar/studentOrderItems?studentId=456&date=2026-09-14' | jq .

# Deliveries
mhlb_get /deliveryInfo/nextDelivery         | jq .
mhlb_get /deliveryInfo/upcomingDeliveries   | jq .
mhlb_get /deliveryInfo/archivedDeliveries   | jq .

# Which vendors are matched to the account's schools
mhlb_get /calendar/viewMatchedVendors | jq .
```

## Cart and menu

```sh
# Valid filter values first — periods (semesters) and status tabs
mhlb_get /event/ShoppingCartBaseData | jq '{periods: [.periods[] | {text, value, selected}]}'

# The cart itself; every filter is optional
mhlb_get '/event/shoppingCart' | jq .
mhlb_get '/event/shoppingCart?selectedStudentId=456' | jq .

# The orderable menu for a student on a date — vendor, items, sizes, prices, cutoff
mhlb_get '/event/orderBaseData?studentId=456&eventDate=2026-09-14' | jq .
```

## Transactions and subscriptions

```sh
mhlb_get /event/transactionsList              | jq .
mhlb_get '/event/transactionDetails?transactionId=999' | jq .
mhlb_get /event/subscription                  | jq .
mhlb_get '/event/upcomingSubscriptions'       | jq .
```

## Gift cards and coupons

```sh
mhlb_get /parent/giftCardDataTables | jq .
mhlb_get /parent/coupon             | jq .
```

## Printable reports

Each returns a reference to a server-rendered PDF.

```sh
mhlb_post /parentReports/printOrders       '{"startDate":"2026-09-01","endDate":"2026-09-30"}' | jq .
mhlb_post /parentReports/printCalendar     '{"startDate":"2026-09-01","endDate":"2026-09-30"}' | jq .
mhlb_post /parentReports/printTransactions '{"startDate":"2026-09-01","endDate":"2026-09-30"}' | jq .
```

## Writes — all UNVERIFIED

Paths and verbs are read out of the site's compiled client and are reliable.
The **request bodies** have not been exercised against a live account. Fetch the
model, edit it, post it back whole, then re-read to confirm.

| Action | Read the model | Post it back |
|---|---|---|
| Place an order | `GET /event/createOrder?eventId=&studentId=` | `POST /event/createOrder` |
| Change an order | `GET /event/editOrder?orderId=` | `POST /event/editOrder` |
| Cancel an order | — | `POST /event/deleteOrder` |
| Add a student | `GET /parent/createChild` | `POST /parent/createChild` |
| Edit a student | `GET /parent/editChild?childId=` | `POST /parent/editChild` |
| Remove a student | — | `POST /parent/deleteChild?id=` |
| Apply a gift card | — | `POST /parent/applyGiftCard?giftCardCode=` |
| Apply a coupon | — | `POST /parent/applyCoupon?couponCode=` |
| Remove the coupon | — | `POST /parent/removeCoupon` |
| Toggle subscriptions | `GET /event/subscription` | `POST /parent/changeSubscriptionStatus?isEnableSubscription=` |
| Stop one subscription | `GET /event/upcomingSubscriptions` | `POST /event/unsubcribeOrder` |
| Price the cart | — | `POST /payment/initCheckout` |
| **Pay** | — | `POST /payment/checkout` |

`POST /event/unsubcribeOrder` is spelled that way upstream — the typo is theirs.

`POST /payment/checkout` charges a real payment method. Price with
`initCheckout` first, read the total it returns, and confirm that figure before
paying.

## Endpoints a parent account cannot reach

The same bundle serves school-admin and vendor roles. These return `403` for a
parent and are listed only so a `403` is not mistaken for a broken session:
`/school`, `/schoolManagement`, `/schoolOnboarding`, `/vendor`, `/vendorReports`,
`/schoolVendorReports`, `/item`, `/adminTasks`, `/quickbooks`, `/docusign`,
`/interactiveDistributionReport`, `/upload`.
