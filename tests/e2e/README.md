# Test e2e de la interfaz

Abre la web en Chrome headless y comprueba el flujo de presentación de principio a fin: crear e importar un
guion, guardado automático, modo Presentar, Espacio para reproducir/pausar/reanudar, clic para continuar
desde una frase, parada al final del bloque, navegación con flechas, *Preparar audio* y recarga.

Usa el motor `fake` y una carpeta de datos temporal, así que **no toca tus voces ni necesita GPU**.

```powershell
# 1. Servidor de pruebas (otra terminal)
$env:TTS_ENGINE="fake"; $env:QUALITY_STT="none"; $env:WORKSPACE_DIR="$env:TEMP\fva-e2e"
.\.venv\Scripts\uvicorn app.main:main_app --factory --port 8799

# 2. Tests (usan el Chrome instalado; cambia la ruta con CHROME_PATH)
cd tests\e2e
npm install
npm test                 # presentación: guion, reproducción, editor en directo, exportar/importar
node micro.test.js       # micrófono real mezclado: M, auto-silencio, prueba de micro (dispositivos simulados)
```

El test espera que la carpeta de datos no tenga presentaciones. Si lo repites, borra `$env:TEMP\fva-e2e`
o usa otra carpeta.
