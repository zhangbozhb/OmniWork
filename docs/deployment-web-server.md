# Web Server Deployment

This document defines how the OmniWork public web layer maps to the relay
server in production.

## Principle

- Production uses Nginx to serve static web assets and terminate HTTPS.
- Production keeps the Node relay focused on `/relay/ws/...`, `/admin/api/...`,
  health checks, and internal operational endpoints.
- The Node-served admin web page is disabled by default. Enable it only for
  development or explicit break-glass debugging with
  `OMNIWORK_RELAY_ADMIN_WEB_ENABLED=true`.
- Development can run `pnpm dev:relay`, which enables `/admin/web` for quick
  local access.

## Paths

| Path | Owner | Purpose |
| --- | --- | --- |
| `/` | Nginx static | Project landing page |
| `/app/` | Nginx static | Web client SPA |
| `/admin/` | Nginx static, optional | Production admin UI |
| `/admin/api/` | Relay via Nginx proxy | Admin API and session auth |
| `/relay/ws/agent` | Relay via Nginx proxy | Agent WebSocket |
| `/relay/ws/mobile` | Relay via Nginx proxy | Mobile/Web client WebSocket |
| `/healthz`, `/readyz` | Relay via Nginx proxy | Health checks |
| `/metrics`, `/debug/...` | Restricted | Internal operations only |

## Web Client Build

Build production web assets for the current static paths:

```bash
OMNIWORK_WEB_RELAY_URL=wss://omniwork.example.com/relay/ws/mobile \
pnpm deploy:web:build
```

This runs the Web client build with `OMNIWORK_WEB_PUBLIC_PATH=/app/`, then
prepares:

```text
dist/deploy/
├── app/
└── admin/
```

Publish those directories to `/var/www/omniwork/app/` and
`/var/www/omniwork/admin/`.

`OMNIWORK_WEB_PUBLIC_PATH` controls webpack's asset prefix. Use `/` for local
root hosting and `/app/` for the production path described here.
`OMNIWORK_WEB_RELAY_URL` is written to
`dist/deploy/app/omniwork-config.js` as runtime configuration, so the same app
bundle is not tied to a hard-coded relay or CDN domain.

## Relay Runtime

Recommended production environment:

```bash
OMNIWORK_RELAY_HOST=127.0.0.1
OMNIWORK_RELAY_PORT=8787
OMNIWORK_RELAY_REQUIRE_E2E=true
OMNIWORK_RELAY_ADMIN_REQUIRE_HTTPS=true
OMNIWORK_RELAY_ADMIN_WEB_ENABLED=false
OMNIWORK_RELAY_ADMIN_TRUST_PROXY=true
OMNIWORK_RELAY_ADMIN_TRUSTED_PROXY_IPS=127.0.0.1,::1
```

Start the relay with:

```bash
pnpm relay:start
```

For local development:

```bash
OMNIWORK_RELAY_ADMIN_REQUIRE_HTTPS=false pnpm dev:relay
```

`pnpm dev:relay` enables the Node-served admin web page at `/admin/web`.

## Nginx

Use `deploy/nginx/omniwork.conf.example` as the baseline server block. Copy it
to the server's Nginx configuration directory and replace:

- `server_name` with the production domain.
- `ssl_certificate` and `ssl_certificate_key` with real certificate paths.
- `/var/www/omniwork/site`, `/var/www/omniwork/app`, and
  `/var/www/omniwork/admin` with the server's actual publish directories.

If admin web is not ready as a static site, disable or restrict the `/admin/`
location and keep only `/admin/api/` proxied to the relay.

## Admin Web Source

Admin HTML lives under `web/admin` and is shared by both production and local
development. Production publishes it to `/var/www/omniwork/admin/` through
`dist/deploy/admin` and proxies only `/admin/api/...` to relay.
The production admin page uses `/admin/` as its base and redirects expired or
missing sessions to `/admin/login.html`.

The local development endpoint remains:

```text
/admin/web
```

The production endpoint is:

```text
/admin/
```
