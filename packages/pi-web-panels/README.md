# pi-web-panels overlay

Local package boundary for the Silrod Operations Panels, background-agent sidebar, and run-detail view. Source is separated from upstream pi-web; Next.js route adapters and explicit UI mounting hooks remain in the host app because App Router routes are discovered from `app/` at build time.

This package is a staging boundary, not yet wired into the clean upstream app. Host-side `app/api/**` adapters must call server exports and supply host services/dependencies; keep filesystem-sensitive code server-only. A future integration should use package subpath exports for `client/*` and `server/*`, with Next transpilation configured explicitly.
