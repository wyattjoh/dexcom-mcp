# Coding Standards

Rules a reviewer applies to a diff. Every rule applies to every change that
touches its area.

## OAuth bridge

Applies to `packages/dexcom-mcp/src/oauth/`, `src/store.ts`, `src/session.ts`,
and `src/login.ts`.

### Invariants

- Dexcom authorization codes are single use and expire in one minute: exchange
  them inside the callback, never at `/token`
- Dexcom refresh tokens are single use: always go through
  `createDexcomSessions`, which single-flights in-process, holds a KV lease
  (`["refresh-lock", userId]`, deadline stored in the value) across processes,
  and persists rotated tokens before use
- Never return or log Dexcom tokens; MCP tokens are stored only as SHA-256
  hashes
- MCP tokens belong to a token family (one authorization plus its rotations)
  bound to the grant's `grantId`. Tokens are valid only while the family is live
  and the user's current grant has that `grantId`. Re-authorizing keeps an
  existing `grantId`; a deleted grant gets a new one, so old tokens never
  revive. A replayed refresh token deletes its family, except the same client
  re-sending it within 10 s (a retry), which is only refused. Records without
  `familyId`/`grantId` are invalid
- Client registrations expire after a day unless used; each token issuance
  extends them to the refresh token lifetime
- `/authorize` requires PKCE S256 and an exact registered `redirect_uri`;
  malformed requests get an error page, never a redirect (no open redirector).
  Consent is bound to a SameSite=Strict cookie, and the Dexcom callback to a
  SameSite=Lax cookie set on approval (so a forwarded Dexcom login URL cannot
  complete someone else's authorization). On https issuers both cookies use the
  `__Host-` prefix with `Path=/`
- Request bodies are read with `readBodyText`, which stops at the size cap
- Only a Dexcom 400 on refresh deletes a grant, and only with a compare-and-swap
  on the versionstamp the refresh read; 429/401/5xx are rethrown
- The same region host serves login, token, and data calls

### Tests

- Each invariant above has a test that goes red when the invariant breaks. A
  diff that changes an invariant's code path changes or adds that test.
- A security fix ships with a test that reproduces the attack (replay, injected
  cookie, oversized streamed body, cross-process race) through the public
  surface: `createHttpHandler`'s `fetch`, `createDexcomSessions`, or the store.
- Races are forced deterministically: a fake Dexcom delay
  (`createFixture(refreshDelayMs)`), a held lease, or separate
  `createDexcomSessions` instances on one store.

## Releases

- A change that breaks an existing deployment (stored records no longer
  accepted, tool output shape, config that used to start and now refuses, moved
  data paths) uses `!` or a `BREAKING CHANGE:` footer, and README's "Upgrading"
  section says what users do.
- Data written by the previous release is refused cleanly (an OAuth error, never
  a 500).
