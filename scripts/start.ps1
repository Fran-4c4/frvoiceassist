# Start frvoiceassist on Windows: create the home data directory, start the container, and open the web UI.
# Usage: .\scripts\start.ps1 [-Build]
param([switch]$Build)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$data = if ($env:FRVOICEASSIST_HOME) { $env:FRVOICEASSIST_HOME } else { Join-Path $env:USERPROFILE "frvoiceassist" }
foreach ($d in "voices", "presentations", "outputs") { New-Item -ItemType Directory -Force (Join-Path $data $d) | Out-Null }
Write-Host "Datos en: $data"

if ($Build) { docker compose build }
docker compose up -d

$port = 8765
if (Test-Path .env) {
    $line = Select-String -Path .env -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
    if ($line) { $port = $line.Matches[0].Groups[1].Value }
}
$url = "http://localhost:$port"
Write-Host "Esperando a que el modelo cargue (la primera vez descarga ~4 GB)..."
for ($i = 0; $i -lt 120; $i++) {
    try {
        $h = Invoke-RestMethod "$url/api/health" -TimeoutSec 3
        if ($h.status -eq "ready") { break }
        if ($h.status -eq "error") { Write-Host "Error cargando el modelo: $($h.error)" -ForegroundColor Red; break }
    } catch { }
    Start-Sleep -Seconds 5
}
Start-Process $url
Write-Host "Listo: $url" -ForegroundColor Green
