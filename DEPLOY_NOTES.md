# Deployment notes

## Cloudflare Access SSO

Set both of these plain-text variables on the `workshop-backend` Worker:

```text
ACCESS_TEAM_DOMAIN=proud-snow-373c.cloudflareaccess.com
ACCESS_APP_AUD=ab109a6557f7907077f44b7d2de778ce902ab026ea91f09158817902045ac9cb
```

`ACCESS_TEAM_DOMAIN` is a hostname only: do not include `https://` or a path. The feature is off
when both variables are absent. A partial pair or any JWT verification failure authenticates
nobody through Access and leaves the ordinary login/signup fallback available.

No frontend build flag or separate asset build is needed. The single frontend bundle attempts the
Access bootstrap first at runtime, then falls back to the existing session/login flow when Access
is unavailable.

Access authentication is intentionally scoped to `authenticateFromCfAccess()` on the existing
`/api` Cap'n Web connection. The assertion captured from that HTTP/WebSocket handshake is verified,
mapped to the email-keyed `UserDurableObject`, issued through the normal stored-session path, and
returns the same `AuthenticatedApi` capability used by password and gatekeeper sessions. WebSocket
authorization is not weakened or moved into headers after bootstrap.

`/api/hermes/wake` is dispatched before `/api` RPC setup and remains protected only by its existing
bearer token. It does not require or consume a Cloudflare Access assertion, matching the separate
Access bypass application for that path.
