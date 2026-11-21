#!/usr/bin/env bash
# Post-deploy smoke test. Read-only: it only sends harmless GET / OPTIONS requests.
#   infra/deploy/smoke-test.sh https://api.yourdomain.com https://admin.yourdomain.com
set -uo pipefail
API="${1:?usage: smoke-test.sh <api-base-url> <admin-base-url>}"
ADMIN="${2:?usage: smoke-test.sh <api-base-url> <admin-base-url>}"
API="${API%/}"; ADMIN="${ADMIN%/}"
fail=0
ok()  { echo "ok    $1"; }
bad() { echo "FAIL  $1"; fail=1; }
status() { curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null || echo 000; }
headers() { curl -sS -D - -o /dev/null --max-time 15 "$@" 2>/dev/null | tr -d '\r' | tr 'A-Z' 'a-z'; }

[ "$(status "$API/api/v1/health")" = 200 ] && ok "API liveness" || bad "API liveness (/api/v1/health)"
[ "$(status "$API/api/v1/health/ready")" = 200 ] && ok "API readiness (database reachable)" || bad "API readiness (/api/v1/health/ready)"
[ "$(status "$API/api/v1/auth/me")" = 401 ] && ok "private route answers 401 without a token" || bad "private route should answer 401 without a token"
[ "$(status "$API/docs")" = 404 ] && ok "Swagger is not exposed" || bad "Swagger must not be reachable in production"

h="$(headers "$API/api/v1/health")"
echo "$h" | grep -q '^strict-transport-security:' && ok "API sends HSTS" || bad "API missing HSTS"
echo "$h" | grep -q '^x-content-type-options: nosniff' && ok "API sends nosniff" || bad "API missing nosniff"
echo "$h" | grep -q '^cache-control: no-store' && ok "API answers are no-store" || bad "API missing Cache-Control: no-store"
echo "$h" | grep -q '^x-powered-by:' && bad "API leaks X-Powered-By" || ok "API hides X-Powered-By"

c="$(headers -X OPTIONS -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: GET' "$API/api/v1/health")"
echo "$c" | grep -q '^access-control-allow-origin:' && bad "CORS allows a foreign origin" || ok "CORS refuses a foreign origin"

[ "$(status "$ADMIN/")" = 200 ] && ok "admin web loads" || bad "admin web (/)"
[ "$(status "$ADMIN/login")" = 200 ] && ok "admin web single-page fallback (/login)" || bad "admin web fallback (/login)"
[ "$(status "$ADMIN/api/v1/health")" = 200 ] && ok "admin web forwards /api to the API" || bad "admin web /api forwarding"
a="$(headers "$ADMIN/")"
echo "$a" | grep -q '^content-security-policy:' && ok "admin web sends a CSP" || bad "admin web missing CSP"
echo "$a" | grep -q '^x-frame-options: deny' && ok "admin web cannot be framed" || bad "admin web missing X-Frame-Options"

host="${API#https://}"
if [ "$API" != "$host" ]; then
  code="$(status "http://$host/api/v1/health")"
  case "$code" in 301|302|307|308) ok "HTTP redirects to HTTPS";; *) bad "HTTP does not redirect to HTTPS (got $code)";; esac
fi
[ "$fail" = 0 ] && echo "Smoke test passed." || { echo "Smoke test FAILED."; exit 1; }
