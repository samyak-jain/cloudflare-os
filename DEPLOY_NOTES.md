# Deployment notes

## Cloudflare Access SSO

Set both of these plain-text variables on the `workshop-backend` Worker:

```text
ACCESS_TEAM_DOMAIN=proud-snow-373c.cloudflareaccess.com
ACCESS_APP_AUD=ab109a6557f7907077f44b7d2de778ce902ab026ea91f09158817902045ac9cb
```

`ACCESS_TEAM_DOMAIN` is a hostname only: do not include `https://` or a path. The feature is off
when both variables are absent. Setting either variable enables the deployment-wide Access gate:
every `/api` request must then be exact-same-origin and carry a fully verified assertion. A partial
pair, malformed team domain, missing assertion, or verification failure rejects the request; it
does not fall back to password login or signup. Configuration errors are logged once per Worker
isolate so an invalid deployment is loud without logging routine invalid tokens.

No frontend build flag or separate asset build is needed. `getServerConfig()` tells the single
frontend bundle whether to attempt Access. A stored app session keeps its existing fast path; with
no stored session, Access is attempted only when the server reports it configured, so local and
ordinary deployments add no guaranteed-failing authentication round trip.

Access authentication uses the existing `/api` Cap'n Web connection. Before either a WebSocket or
HTTP-batch RPC session is constructed, the handler verifies the assertion and exact browser origin.
`authenticateFromCfAccess()` maps the lowercased, NFC-normalized email to its passwordless
`UserDurableObject` and returns the same `AuthenticatedApi` implementation used by other login
methods. It does not mint a permanent app-session row on each reconnect. Password login and signup
RPCs remain disabled whenever Access is configured.

Preview deployments also set `DISABLE_PASSWORD_AUTH=true` as a plain-text defense-in-depth var. The
backend's Access hard gate is authoritative even if that variable is omitted.

`/api/hermes/wake` is dispatched before `/api` RPC setup and remains protected only by its existing
bearer token. It does not require or consume a Cloudflare Access assertion, matching the separate
Access bypass application for that path.
