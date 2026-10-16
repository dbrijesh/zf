# Extended checks

## New endpoint
- Authentication required unless explicitly public; authorisation per object, not only per route.
- Rate limit or abuse control for expensive or unauthenticated calls.
- Response never includes fields the caller should not see (internal ids, hashes, tokens).
- CSRF protection for cookie-authenticated state changes.

## File upload
- Size limit, type allowlist by content not by extension, random server-side file name.
- Stored outside the web root; never executed; scanned if the policy requires it.

## Deserialisation and parsing
- No deserialisation of untrusted data into arbitrary types.
- XML parsers with external entities disabled; YAML safe-load only.
- Limits on depth and size of JSON and archives (zip bombs, path traversal in entries).

## Cryptography
- Standard library primitives only; no custom schemes.
- Passwords hashed with a slow salted hash; tokens compared in constant time.
- Keys and IVs generated with a secure random source; keys never in source.

## Server-side requests
- User-supplied URLs resolved and checked against an allowlist; block private and link-local ranges.

## Logging
- No credentials, tokens, full card numbers or personal data in logs; security events (login failure, permission denied, approval) are logged.
