# Post-deploy smoke test (Windows PowerShell 5.1+ / PowerShell 7). Read-only: harmless GET / OPTIONS requests only.
#   .\infra\deploy\smoke-test.ps1 -Api https://api.yourdomain.com -Admin https://admin.yourdomain.com
param(
  [Parameter(Mandatory = $true)][string]$Api,
  [Parameter(Mandatory = $true)][string]$Admin
)
$Api = $Api.TrimEnd('/'); $Admin = $Admin.TrimEnd('/')
$script:failed = $false
function Ok($m)  { Write-Host "ok    $m" -ForegroundColor Green }
function Bad($m) { Write-Host "FAIL  $m" -ForegroundColor Red; $script:failed = $true }

function Call([string]$Url, [string]$Method = 'GET', [hashtable]$Headers = @{}) {
  try {
    $p = @{ Uri = $Url; Method = $Method; Headers = $Headers; UseBasicParsing = $true; TimeoutSec = 15; MaximumRedirection = 0 }
    return Invoke-WebRequest @p -ErrorAction Stop
  } catch {
    if ($_.Exception.Response) { return $_.Exception.Response }
    return $null
  }
}
function Code($r)   { if ($null -eq $r) { return 0 }; return [int]$r.StatusCode }
function Header($r, [string]$name) {
  if ($null -eq $r) { return $null }
  $v = $r.Headers[$name]
  if ($v -is [array]) { return ($v -join ',') }
  return $v
}

if ((Code (Call "$Api/api/v1/health")) -eq 200) { Ok 'API liveness' } else { Bad 'API liveness (/api/v1/health)' }
if ((Code (Call "$Api/api/v1/health/ready")) -eq 200) { Ok 'API readiness (database reachable)' } else { Bad 'API readiness (/api/v1/health/ready)' }
if ((Code (Call "$Api/api/v1/auth/me")) -eq 401) { Ok 'private route answers 401 without a token' } else { Bad 'private route should answer 401 without a token' }
if ((Code (Call "$Api/docs")) -eq 404) { Ok 'Swagger is not exposed' } else { Bad 'Swagger must not be reachable in production' }

$h = Call "$Api/api/v1/health"
if (Header $h 'Strict-Transport-Security') { Ok 'API sends HSTS' } else { Bad 'API missing HSTS' }
if ((Header $h 'X-Content-Type-Options') -eq 'nosniff') { Ok 'API sends nosniff' } else { Bad 'API missing nosniff' }
if ((Header $h 'Cache-Control') -like '*no-store*') { Ok 'API answers are no-store' } else { Bad 'API missing Cache-Control: no-store' }
if (Header $h 'X-Powered-By') { Bad 'API leaks X-Powered-By' } else { Ok 'API hides X-Powered-By' }

$c = Call "$Api/api/v1/health" 'OPTIONS' @{ 'Origin' = 'https://evil.example'; 'Access-Control-Request-Method' = 'GET' }
if (Header $c 'Access-Control-Allow-Origin') { Bad 'CORS allows a foreign origin' } else { Ok 'CORS refuses a foreign origin' }

if ((Code (Call "$Admin/")) -eq 200) { Ok 'admin web loads' } else { Bad 'admin web (/)' }
if ((Code (Call "$Admin/login")) -eq 200) { Ok 'admin web single-page fallback (/login)' } else { Bad 'admin web fallback (/login)' }
if ((Code (Call "$Admin/api/v1/health")) -eq 200) { Ok 'admin web forwards /api to the API' } else { Bad 'admin web /api forwarding' }
$a = Call "$Admin/"
if (Header $a 'Content-Security-Policy') { Ok 'admin web sends a CSP' } else { Bad 'admin web missing CSP' }
if ((Header $a 'X-Frame-Options') -eq 'DENY') { Ok 'admin web cannot be framed' } else { Bad 'admin web missing X-Frame-Options' }

if ($Api.StartsWith('https://')) {
  $code = Code (Call ('http://' + $Api.Substring(8) + '/api/v1/health'))
  if (@(301, 302, 307, 308) -contains $code) { Ok 'HTTP redirects to HTTPS' } else { Bad "HTTP does not redirect to HTTPS (got $code)" }
}
if ($script:failed) { Write-Host 'Smoke test FAILED.' -ForegroundColor Red; exit 1 } else { Write-Host 'Smoke test passed.' }
