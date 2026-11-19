# Quick end-to-end check against the running service.
# Usage: .\scripts\smoke_test.ps1 [-Text "Hello world"] [-Voice me] [-BaseUrl http://localhost:8765]
param(
    [string]$Text = "Hello everyone, and thank you for joining today's presentation.",
    [string]$Voice = "me",
    [string]$BaseUrl = "http://localhost:8765",
    [string]$Out = (Join-Path $env:TEMP "frvoiceassist_smoke_test.wav")
)
$ErrorActionPreference = "Stop"

$health = Invoke-RestMethod "$BaseUrl/api/health"
Write-Host "Estado: $($health.status) · motor: $($health.engine) · modelo: $($health.model)"
if ($health.status -ne "ready") {
    Write-Host "El modelo aún no está listo (o falló). Revisa: docker compose logs -f tts" -ForegroundColor Yellow
    if ($health.error) { Write-Host $health.error -ForegroundColor Red }
    exit 1
}

$voices = Invoke-RestMethod "$BaseUrl/api/voices"
if (-not ($voices | Where-Object { $_.name -eq $Voice })) {
    Write-Host "No existe la voz '$Voice'. Créala en $BaseUrl (pestaña 'Mi voz')." -ForegroundColor Yellow
    exit 1
}

$body = @{ text = $Text; voice = $Voice; language = "English" } | ConvertTo-Json
$sw = [Diagnostics.Stopwatch]::StartNew()
$res = Invoke-WebRequest "$BaseUrl/api/tts" -Method Post -ContentType "application/json" -Body $body -OutFile $Out -PassThru
$sw.Stop()
Write-Host ("OK: {0} · audio {1}s · generación {2}s · total {3:N1}s" -f $Out, $res.Headers["X-Audio-Duration"], $res.Headers["X-Generation-Seconds"], $sw.Elapsed.TotalSeconds) -ForegroundColor Green
