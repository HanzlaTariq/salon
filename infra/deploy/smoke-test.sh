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
headers() { curl -sS -D - -o /dev/null --max-time 15 "$@" 2>/dev/null | tr -d '\r' | tr '[:upper:]' '[:lower:]'; }

# expect_status <url> <expected-code> <ok message> <fail message>
expect_status() {
  if [ "$(status "$1")" = "$2" ]; then ok "$3"; else bad "$4"; fi
}
# has_header <headers> <regex> <ok message> <fail message>   (passes when the header IS present)
has_header() {
  if echo "$1" | grep -q "$2"; then ok "$3"; else bad "$4"; fi
}
# lacks_header <headers> <regex> <ok message> <fail message>  (passes when the header is ABSENT)
lacks_header() {
  if echo "$1" | grep -q "$2"; then bad "$4"; else ok "$3"; fi
}

expect_status "$API/api/v1/health" 200 "API liveness" "API liveness (/api/v1/health)"
expect_status "$API/api/v1/health/ready" 200 "API readiness (database reachable)" "API readiness (/api/v1/health/ready)"
expect_status "$API/api/v1/auth/me" 401 "private route answers 401 without a token" "private route should answer 401 without a token"
expect_status "$API/docs" 404 "Swagger is not exposed" "Swagger must not be reachable in production"

h="$(headers "$API/api/v1/health")"
has_header "$h" '^strict-transport-security:' "API sends HSTS" "API missing HSTS"
has_header "$h" '^x-content-type-options: nosniff' "API sends nosniff" "API missing nosniff"
has_header "$h" '^cache-control: no-store' "API answers are no-store" "API missing Cache-Control: no-store"
lacks_header "$h" '^x-powered-by:' "API hides X-Powered-By" "API leaks X-Powered-By"

c="$(headers -X OPTIONS -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: GET' "$API/api/v1/health")"
lacks_header "$c" '^access-control-allow-origin:' "CORS refuses a foreign origin" "CORS allows a foreign origin"

expect_status "$ADMIN/" 200 "admin web loads" "admin web (/)"
expect_status "$ADMIN/login" 200 "admin web single-page fallback (/login)" "admin web fallback (/login)"
expect_status "$ADMIN/api/v1/health" 200 "admin web forwards /api to the API" "admin web /api forwarding"
a="$(headers "$ADMIN/")"
has_header "$a" '^content-security-policy:' "admin web sends a CSP" "admin web missing CSP"
has_header "$a" '^x-frame-options: deny' "admin web cannot be framed" "admin web missing X-Frame-Options"

host="${API#https://}"
if [ "$API" != "$host" ]; then
  code="$(status "http://$host/api/v1/health")"
  case "$code" in 301|302|307|308) ok "HTTP redirects to HTTPS";; *) bad "HTTP does not redirect to HTTPS (got $code)";; esac
fi
if [ "$fail" = 0 ]; then
  echo "Smoke test passed."
else
  echo "Smoke test FAILED."
  exit 1
fi
