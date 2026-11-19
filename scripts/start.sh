#!/usr/bin/env bash
# Start frvoiceassist on Linux/macOS: create ~/frvoiceassist, run the container with the current UID/GID
# so files belong to the user instead of root, and wait for the model to become ready.
# Usage: ./scripts/start.sh [--build]
set -euo pipefail
cd "$(dirname "$0")/.."

DATA="${FRVOICEASSIST_HOME:-$HOME/frvoiceassist}"
mkdir -p "$DATA/voices" "$DATA/presentations" "$DATA/outputs"
echo "Datos en: $DATA"

export APP_UID="$(id -u)" APP_GID="$(id -g)"
[[ "${1:-}" == "--build" ]] && docker compose build
docker compose up -d

PORT="$(grep -E '^\s*PORT\s*=' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d ' ' || true)"
URL="http://localhost:${PORT:-8765}"
echo "Esperando a que el modelo cargue (la primera vez descarga ~4 GB)..."
for _ in $(seq 1 120); do
  status="$(curl -fsS "$URL/api/health" 2>/dev/null | grep -o '"status":"[a-z]*"' || true)"
  [[ "$status" == *ready* ]] && break
  [[ "$status" == *error* ]] && { echo "Error cargando el modelo: docker compose logs tts"; break; }
  sleep 5
done
echo "Listo: $URL"
command -v xdg-open >/dev/null && xdg-open "$URL" >/dev/null 2>&1 || true
