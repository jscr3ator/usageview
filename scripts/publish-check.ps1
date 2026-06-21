$ErrorActionPreference = "Stop"

npm run check
npm test
npm audit
python -m py_compile scripts\collect_codex.py

$patterns = @(
  "Liquid Stats",
  "liquid-stats",
  "DASHBOARD_PASSWORD",
  "SPOTIFY_CLIENT_SECRET=.+",
  "SPOTIFY_REFRESH_TOKEN=.+",
  "C:\\Users\\",
  "\bflash\b",
  "\b10\.\d+\.\d+\.\d+\b",
  "\b172\.(1[6-9]|2[0-9]|3[0-1])\.\d+\.\d+\b",
  "\b192\.168\.\d+\.\d+\b",
  "GPU_QUERY_COMMAND",
  "execShell",
  "gradient",
  "linear-",
  "radial-",
  "conic-"
)

foreach ($pattern in $patterns) {
  $matches = rg -n $pattern . -g "!data/**" -g "!node_modules/**" -g "!release/**" -g "!scripts/publish-check.ps1"
  if ($LASTEXITCODE -eq 0) {
    Write-Host $matches
    throw "Publish check failed: matched '$pattern'"
  }
  if ($LASTEXITCODE -ne 1) {
    throw "Publish check failed while scanning '$pattern'"
  }
}

Write-Host "UsageView publish checks passed."
