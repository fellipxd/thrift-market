<#
.SYNOPSIS
  Local development setup on Windows: PostgreSQL 16 + PostGIS, .env, dependencies and database migrations.

.DESCRIPTION
  Default: runs PostgreSQL 16 + PostGIS in Docker (docker compose, the same image the README uses).
  -UseLocalPostgres: uses a PostgreSQL already installed on Windows instead. It needs the PostGIS extension
  (Application Stack Builder > Spatial Extensions > PostGIS for your PostgreSQL version). The script creates the
  development-only "thrift" role (password "thrift", matching .env.example) and the thrift_dev/thrift_test databases,
  connecting as the PostgreSQL superuser (asks for that password once).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\dev-setup.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\dev-setup.ps1 -UseLocalPostgres
#>
param(
  [switch]$UseLocalPostgres,
  [string]$PsqlPath,
  [string]$SuperUser = 'postgres',
  # Optional; when omitted you are asked for it (input hidden).
  [string]$SuperUserPassword,
  [int]$Port = 5432
)

# Native commands are checked through $LASTEXITCODE. ('Stop' would turn redirected stderr from docker/psql into
# terminating errors in Windows PowerShell 5.1.)
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Stop-Setup([string]$Message) {
  Write-Host ''
  Write-Host $Message -ForegroundColor Red
  exit 1
}

function Test-PortInUse([int]$PortNumber) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $attempt = $client.BeginConnect('127.0.0.1', $PortNumber, $null, $null)
    if (-not $attempt.AsyncWaitHandle.WaitOne(700)) { return $false }
    $client.EndConnect($attempt)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Get-RunningPostgresServices {
  if (-not (Get-Command Get-Service -ErrorAction SilentlyContinue)) { return @() }
  return @(Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' })
}

function Find-Psql {
  if ($PsqlPath) { return $PsqlPath }
  $onPath = Get-Command psql -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  $installed = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue |
    Sort-Object { [int]($_.Directory.Parent.Name -replace '\D', '') } -Descending |
    Select-Object -First 1
  if ($installed) { return $installed.FullName }
  return $null
}

# 1. Settings file -------------------------------------------------------------------------------------------------
if (Test-Path .env) {
  Write-Step '.env already exists (kept as is)'
} else {
  Copy-Item .env.example .env
  Write-Step 'Created .env from .env.example'
}

# 2. Database ------------------------------------------------------------------------------------------------------
if ($UseLocalPostgres) {
  $psql = Find-Psql
  if (-not $psql) {
    Stop-Setup 'psql.exe was not found. Pass its path, e.g. -PsqlPath "C:\Program Files\PostgreSQL\16\bin\psql.exe".'
  }
  if (-not (Test-PortInUse $Port)) {
    Stop-Setup "Nothing is listening on localhost:$Port. Start the PostgreSQL service (services.msc) and run this again."
  }
  Write-Step "Using $psql on localhost:$Port as '$SuperUser'"
  if ($SuperUserPassword) {
    $env:PGPASSWORD = $SuperUserPassword
  } else {
    $secure = Read-Host "Password for the PostgreSQL user '$SuperUser'" -AsSecureString
    $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  }
  try {
    $postgis = & $psql -U $SuperUser -h localhost -p $Port -d postgres -tAc "SELECT count(*) FROM pg_available_extensions WHERE name = 'postgis'"
    if ($LASTEXITCODE -ne 0) { Stop-Setup "Could not sign in to PostgreSQL as '$SuperUser'. Check the password (or pass -SuperUser)." }
    if ("$postgis".Trim() -ne '1') {
      Stop-Setup ("PostGIS is not installed for this PostgreSQL. Open 'Application Stack Builder', choose your PostgreSQL, " +
        "then Spatial Extensions > PostGIS, install it, and run this again. (Or use Docker: run this script without -UseLocalPostgres.)")
    }
    $sql = @'
SELECT 'CREATE ROLE thrift WITH LOGIN SUPERUSER PASSWORD ''thrift''' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'thrift')
\gexec
ALTER ROLE thrift WITH LOGIN SUPERUSER PASSWORD 'thrift';
SELECT 'CREATE DATABASE thrift_dev OWNER thrift' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'thrift_dev')
\gexec
SELECT 'CREATE DATABASE thrift_test OWNER thrift' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'thrift_test')
\gexec
'@
    $sql | & $psql -U $SuperUser -h localhost -p $Port -d postgres -v ON_ERROR_STOP=1 -q
    if ($LASTEXITCODE -ne 0) { Stop-Setup 'Creating the thrift role or databases failed (see the message above).' }
    Write-Step "Role 'thrift' (password set to 'thrift' to match .env, development only) and databases thrift_dev, thrift_test are ready"
  } finally {
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  }
} else {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Stop-Setup ("Docker was not found. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) and run this again, " +
      "or use a PostgreSQL installed on Windows: scripts\dev-setup.ps1 -UseLocalPostgres")
  }
  docker info *> $null
  if ($LASTEXITCODE -ne 0) { Stop-Setup 'Docker is installed but not running. Start Docker Desktop, wait until it is ready, and run this again.' }

  $ours = docker compose ps -q postgres 2> $null
  if (-not $ours -and (Test-PortInUse $Port)) {
    $services = Get-RunningPostgresServices
    if ($services.Count -gt 0) {
      $names = ($services | ForEach-Object { $_.Name }) -join ', '
      Stop-Setup ("Port $Port is already used by a PostgreSQL installed on Windows (service: $names). Either use it: " +
        "scripts\dev-setup.ps1 -UseLocalPostgres`nor stop it first (PowerShell as administrator: Stop-Service $($services[0].Name)) and run this again.")
    }
    Stop-Setup ("Port $Port is already in use by another program (another PostgreSQL or container?). " +
      "Free the port, or use that PostgreSQL with: scripts\dev-setup.ps1 -UseLocalPostgres")
  }

  Write-Step 'Starting PostgreSQL 16 + PostGIS in Docker'
  docker compose up -d postgres
  if ($LASTEXITCODE -ne 0) { Stop-Setup 'docker compose up failed (see the message above).' }
  $ready = $false
  for ($i = 0; $i -lt 90; $i++) {
    docker compose exec -T postgres pg_isready -U thrift -d thrift_dev *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { Stop-Setup 'PostgreSQL did not become ready in 90 seconds. Check: docker compose logs postgres' }
  Write-Step 'PostgreSQL is ready'
}

# 3. Dependencies and schema ---------------------------------------------------------------------------------------
Write-Step 'Installing dependencies'
pnpm install
if ($LASTEXITCODE -ne 0) { Stop-Setup 'pnpm install failed.' }

Write-Step 'Applying database migrations'
pnpm db:migrate
if ($LASTEXITCODE -ne 0) { Stop-Setup 'Migrations failed (see the hint above).' }

Write-Host ''
Write-Host 'Ready. Next:' -ForegroundColor Green
Write-Host '  pnpm db:reseed      # reference data + demo shops'
Write-Host '  pnpm dev            # web app on http://localhost:3000'
Write-Host '  pnpm dev:worker     # background worker (second terminal)'
