Param(
  [switch]$Rebuild = $false,
  [switch]$Seed = $true
)

Write-Host "[+] Ensuring .env exists..." -ForegroundColor Cyan
if (-Not (Test-Path ".env")) {
  Copy-Item -Path "env.example" -Destination ".env"
  Add-Content ".env" "`nNEO4J_PASSWORD=changeme" # fallback if missing
  Write-Host "[+] Created .env from env.example" -ForegroundColor Green
}

if ($Rebuild) {
  Write-Host "[+] Building images..." -ForegroundColor Cyan
  docker compose build --no-cache
}

Write-Host "[+] Starting stack (neo4j, crm-agent, dashboard-api)..." -ForegroundColor Cyan
docker compose up -d

Write-Host "[+] Waiting Neo4j to be healthy on bolt://localhost:7687..." -ForegroundColor Cyan
Start-Sleep -Seconds 8

if ($Seed) {
  Write-Host "[+] Seeding Neo4j constraints/indexes..." -ForegroundColor Cyan
  $Cypher = Get-Content -Raw "neo4j-multitenancy.cypher"
  $User = $env:NEO4J_USER
  if (-Not $User) { $User = "neo4j" }
  $Pass = $env:NEO4J_PASSWORD
  if (-Not $Pass) { $Pass = "changeme" }
  docker exec -i neo4j cypher-shell -u $User -p $Pass --format plain < "neo4j-multitenancy.cypher"
}

Write-Host "[+] URLs:" -ForegroundColor Yellow
Write-Host "  - CRM Agent:     http://localhost:3010/health"
Write-Host "  - Dashboard API: http://localhost:3007/health"
Write-Host "  - Neo4j Browser:  http://localhost:7474 (user: neo4j / pass: changeme)" 


