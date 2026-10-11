# Auto Fixes loading state

**Status:** DONE
**Progress:** 2/2

Complexity: 1 → LOW; risk override: none.

Opening Auto Fixes currently displays all repairs before GET /api/fix-config resolves. Show a loading status and disable Apply until the check settles, including each reopen. Preserve cancellation and the existing fallback on failed checks.

Integration: unchanged — Dashboard → FixConfig → existing configuration endpoint.

## Acceptance

- [x] local, agent: delayed checks show loading without repair rows or an all-set claim; resolved checks show actual pending repairs or all-set. Proof: focused configuration repair tests.
- [x] local, agent: reopening checks again, cancelled checks cannot replace current results, and failed checks release loading. Proof: focused tests and typecheck.

Scope: FixConfig, configuration repair tests. No endpoint or shared Modal changes.

Validation: Node 24.16.0; all 35 app tests passed (including 7 configuration repair tests), typecheck and production build passed. No manual browser check. Existing fallback after failed checks is preserved.
