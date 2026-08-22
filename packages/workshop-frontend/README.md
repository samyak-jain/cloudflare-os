# Gadgets Workshop Frontend

Single-page app for the Gadgets Workshop UI. Built with React, Kumo, and Vite.

## Development

```sh
pnpm dev                # start dev server on http://localhost:3000
pnpm exec vp run build  # type-check and build for production
pnpm preview            # preview production build locally
```

`build` is a Vite+ task, not a package.json script, so that it can declare the `VITE_*` flags
as fingerprinted env: a cached `vp` run executes each task in a clean environment, which drops any
ambient value, and a flag the fingerprint ignores means a changed flag replays the old bundle.

It always produces a production bundle, whatever `NODE_ENV` the shell holds, and it deletes `dist/`
before building — a cache hit restores archived files without deleting any, so the previous build's
sourcemaps would otherwise linger. `vite.config.ts` documents both.

## Authentication bootstrap

Every frontend build first tries `authenticateFromCfAccess()` at runtime. When the backend has a
valid Cloudflare Access assertion, the user lands directly in the app. When Access is not configured
or the assertion cannot be verified, the frontend continues through the existing stored-session and
login/signup flow. No frontend build flag is required.

Enable Access on the backend with both `ACCESS_TEAM_DOMAIN` (hostname only, such as
`team.cloudflareaccess.com`) and `ACCESS_APP_AUD`. Leaving both absent preserves ordinary local and
password-based development.
