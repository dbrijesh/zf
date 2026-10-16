# Edge cases by domain

## Money and payments
- Amounts exactly at, one cent below and one cent above a threshold.
- Zero, negative and very large amounts; currencies with 0 or 3 decimals (JPY, KWD).
- Rounding mode and where rounding happens (per line or per total).
- Idempotency: the same request twice; the same request twice concurrently.
- Partial refunds and refunds after a chargeback.
- Retries after a timeout when the first call actually succeeded.

## Dates and time
- Time zones, daylight saving change days, end of month, leap day.
- Cut-off times in the customer's zone versus UTC.
- Date-only values compared to timestamps.

## Personal data (PII)
- Data in logs, error messages, analytics events and test fixtures.
- Deletion and export requests; retention periods.
- Masking in non-production environments.
- Access by role: who can see the unmasked value.

## Lists and limits
- Empty list, one item, page boundary, maximum size plus one.
- Duplicate entries, unicode and very long strings.

## Permissions
- Unauthenticated, wrong role, right role wrong tenant, the requester approving their own item.
