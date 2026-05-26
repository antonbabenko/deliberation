```
╔═══════════════════════════════════════════════════════════════════════════╗
║  /ask-all — Architect debate on my-awesome-repo improvements              ║
╚═══════════════════════════════════════════════════════════════════════════╝

  PROMPT
    "Potential improvements in this repo — useful, beyond the basics."

  ────────────────────────────────────────────────────────────────────────────────
  ROUND 1 — top finding from each
  ────────────────────────────────────────────────────────────────────────────────
  GPT     Marketplace ResolveCustomer cache lives in Flask session →
          /signup's _force_fresh_auth() session.clear() wipes it.
          Token is single-use → user permanently trapped. Move to DDB+TTL.

  Gemini  CloudFront distribution-wide 403→404 override hijacks API Gateway
          403s (CSRF, auth). JSON clients get HTML /404.html. Fix: grant
          OAC s3:ListBucket so S3 returns native 404, remove override.

  Grok    Extract Cognito JWKS freshness check into reusable middleware in
          Mangum entrypoint. Centralize the PR #14 fix. (no FS access)

  ────────────────────────────────────────────────────────────────────────────────
  ROUND 2 — peer critique
  ────────────────────────────────────────────────────────────────────────────────
  GPT on Gemini   ✓ Correct & important. main.tf confirms distribution-wide
                  rule; OAC has only s3:GetObject. Minor: masks ALL origin
                  403s, not just CSRF/auth.
  GPT on Grok     ✗ Mis-aimed. Repo already funnels /login?prompt=login +
                  /signup through _force_fresh_auth(). JWKS validates
                  signature, not freshness. Not the top fix.

  Gemini on GPT   ✓ Critical blocker. Confirmed call path:
                  /api/onboarding/resolve-aws-token → cache → /signup
                  session.clear() → /api/onboarding/link-aws fails.
  Gemini on Grok  ✗ "Nonsense." JWKS verifies signatures, not freshness
                  (that's auth_time claim). Pre-redirect validation
                  impossible — user has no ID token yet. PR #14 placement
                  is already correct.

  Grok on GPT     ✓ Plausible. Single-use token + session wipe = stuck.
                  Quibble: any durable store works, not only DDB.
  Grok on Gemini  ✓ Plausible. Quibble: s3:ListBucket isn't the fix —
                  rule should be path-restricted or removed for /api/*.

  ────────────────────────────────────────────────────────────────────────────────
  DISAGREEMENT MATRIX
  ────────────────────────────────────────────────────────────────────────────────
  Topic              │ GPT                    │ Gemini                │ Grok
  ───────────────────┼────────────────────────┼───────────────────────┼──────────
  CloudFront 403→404 │ Route manifest rework  │ OAC s3:ListBucket fix │ Path-scope rule
  Top priority       │ Marketplace cache bug  │ Missing TEAM_TOKENS   │ JWKS middleware
  Marketplace flow   │ Correctness (data loss)│ Perf (STS roundtrip)  │ Not mentioned
  Email change       │ Token UserId drift     │ Multi-device sessions │ Not mentioned
  Turnstile bypass   │ Found (silent fallback)│ Not mentioned         │ Not mentioned
  JWKS middleware    │ Wrong layer            │ Technically invalid   │ Own pitch
  Vote: most impt    │ Gemini's 403 hijack    │ GPT's Marketplace bug │ Gemini's 403

  ────────────────────────────────────────────────────────────────────────────────
  CONCLUSION
  ────────────────────────────────────────────────────────────────────────────────
  • Two ship-now bugs converged on:
      1. GPT's Marketplace cache wipe (Gemini verified call path)
      2. Gemini's CloudFront 403→404 hijack (GPT verified main.tf rule)
  • Grok lost both rounds — JWKS pitch dismissed as wrong layer by both peers.
  • 2-of-3 vote: Gemini's 403 hijack is most impactful (breaks every API client).
    GPT votes Gemini. Grok votes Gemini. Gemini votes GPT.

  Action order:
    1. Verify + fix CloudFront 403 override     (Quick)
    2. Move Marketplace cache to DDB+TTL        (Short)
    3. Audit Turnstile prod config              (Quick)
    4. Skip JWKS middleware                     (invalid)
```