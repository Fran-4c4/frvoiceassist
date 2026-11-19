# frvoiceassist

> **English summary.** Local, self-hosted voice assistant for giving presentations in English with **your own
> cloned voice**. Write your script in blocks, the app generates the audio with
> [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) (Docker + NVIDIA GPU), and you play it sentence by sentence
> into Teams / Google Meet through a virtual audio cable (VB-CABLE). You can pause, answer questions, add new
> blocks on the fly, resume from any sentence, and mix in your real microphone (`M` key). FastAPI backend and a
> dependency-free web UI. The UI and docs are in Spanish. MIT licensed.

Asistente de voz local para **presentar en inglés con tu voz clonada**. Preparas el guion por bloques, la app
genera el audio con [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) (Docker + GPU NVIDIA) y tú lo vas
reproduciendo a mano, frase a frase, enviándolo a Teams o Google Meet como si fuera tu micrófono.
Si te interrumpen, pausas, respondes y continúas desde la frase que quieras.

```
Navegador (http://localhost:8765)
  │  bloques/frases ───► FastAPI ──► Qwen3-TTS 1.7B Base (GPU) ──► audio por frase (caché)
  │                         │              ▲
  │                         │              └── ~/frvoiceassist/voices/me (tu audio + transcripción)
  ◄── audio ────────────────┘
  └─► salida "CABLE Input" ──► Teams / Meet (micrófono "CABLE Output")
```

## Requisitos

| Requisito | Notas |
|---|---|
| GPU NVIDIA con memoria suficiente | El modelo 1.7B requiere más memoria que el 0.6B; el consumo depende del entorno. |
| Driver NVIDIA reciente | Compatible con CUDA 12.8 (driver ≥ 570). |
| Docker con GPU | Windows: Docker Desktop (WSL2). Linux: NVIDIA Container Toolkit. `docker info` debe listar `nvidia`. |
| ~15 GB de disco | Imagen (~8 GB) + modelo descargado (~4 GB). |
| Chrome o Edge | Para grabar tu voz y elegir el dispositivo de salida. |
| (Opcional) VB-CABLE | Para usarlo como micrófono en Teams/Meet. Ver [docs/virtual-microphone.md](docs/virtual-microphone.md). |

## Tus datos: `~/frvoiceassist`

Las voces, presentaciones y audios son personales y viven **fuera del repo**, en tu home:
`C:\Users\<usuario>\frvoiceassist` en Windows y `~/frvoiceassist` en Linux. Docker Compose monta esa carpeta
en el contenedor. Detalles y estructura en [docs/data-folder.md](docs/data-folder.md).

## Modelos TTS

Se admiten los dos modelos Base de Qwen3-TTS:

| Modelo | Uso recomendado |
|---|---|
| `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | Opción predeterminada, con mayor capacidad y consumo de recursos. |
| `Qwen/Qwen3-TTS-12Hz-0.6B-Base` | Alternativa más ligera que también puede ofrecer buena calidad de voz. |

Selecciona el modelo con `TTS_MODEL` en `.env` y reinicia el servicio con `docker compose up -d`. Cambiar de
modelo no modifica las voces guardadas; los clips se almacenan con una clave de caché distinta para cada modelo.

## Puesta en marcha

```powershell
# Windows: crea ~/frvoiceassist, construye si hace falta, arranca y abre la web
.\scripts\start.ps1 -Build
```

```bash
# Linux: igual, pero ejecuta el contenedor con tu UID/GID (los ficheros serán tuyos, no de root)
./scripts/start.sh --build
```

Paso a paso, sin los scripts:

```powershell
Copy-Item .env.example .env                              # opcional
docker compose build                                     # la 1ª vez descarga PyTorch con CUDA
docker compose run --rm tts python scripts/check_gpu.py  # comprobar la GPU
docker compose up -d                                     # la 1ª vez descarga el modelo (~4 GB)
docker compose logs -f tts                               # espera a "Modelo cargado en ..."
start http://localhost:8765
```

## Uso

### 1. Mi voz
Graba 10–20 s leyendo el texto propuesto (en inglés o en español, botones *Texto EN* / *Texto ES*) y pulsa
*Guardar voz*. Al guardar se **comprueba la grabación**: volumen, ruido (SNR), saturación y si Whisper oye
lo mismo que dice la transcripción.

### 2. Presentación

**Cómo prepararla**
1. **Escribe el guion** en *Editar* (`E`). Usa un bloque por diapositiva o idea. Cada bloque tiene:
   - un **título o comentario** para ti, que no se lee, por ejemplo "Diapositiva 3 – costes";
   - el **texto** que se dirá. El texto entre `[corchetes]` se ve pero no se lee, para notas como `[pausa]`.

   *Pegar guion…* crea los bloques de golpe: cada línea `# título` abre un bloque nuevo.
2. **El audio se prepara solo**, en segundo plano, si *Automático* está marcado (o pulsa *Preparar audio*).
   Cada bloque muestra **✓ listo**, **⏳ preparando** o **○ pendiente**. El tiempo de generación depende del
   equipo y del modelo, así que prepáralo con antelación. El audio se cachea y solo se regenera lo que cambies.
3. **Presenta** en *Presentar* (`P`). La pestaña incluye la guía *¿Cómo preparo la presentación?*.

**Durante la presentación, si te preguntan:** pulsa `N` (o *＋ Bloque*) y escribe la respuesta.
- El bloque se inserta debajo del actual.
- Se prepara **antes que nada**, aunque *Automático* esté apagado.
- Lo que esté sonando no se corta.
- Cuando marque ✓, `Espacio` lo reproduce.

Con ✎ editas un bloque y con ✕ lo eliminas **junto con su audio**. También al editar se borra el audio de
las frases que quitas. Un audio solo se borra si no lo usa ningún otro bloque ni otra presentación.

**Guardar y llevártela**
- Todo se guarda solo en `~/frvoiceassist/presentations`.
- **Exportar guion** descarga un `.md` editable y reimportable.
- **Exportar todo** descarga un `.zip` con:
  - el guion;
  - el audio de cada frase;
  - `presentacion_completa.wav` con todo seguido, como respaldo si algo falla en plena reunión.
- **Abrir archivo…** importa un `.md` o un `.zip` como presentación nueva. Con el `.zip` no hay que volver a
  generar el audio, siempre que el otro equipo tenga la misma voz (copia `~/frvoiceassist/voices`).

**Presentar** (`P`): el texto se muestra por frases. Tú controlas la reproducción:

La barra inferior permite cambiar la velocidad entre 0,75× y 2× y desplazarse a cualquier punto de la frase
actual. La velocidad elegida también se aplica al reproductor de *Texto libre* y se recuerda en el navegador.

| Tecla | Acción |
|---|---|
| `Espacio` | Reproducir desde el cursor / pausa / continuar |
| `Enter` | Repetir la frase del cursor desde el principio |
| `Esc` | Parar |
| `→` / `←` | Frase siguiente / anterior |
| `↓` / `↑` (o `Av Pág` / `Re Pág`) | Bloque siguiente / inicio del bloque (otra vez: bloque anterior) |
| `Inicio` / `Fin` | Primer / último bloque |
| Clic / doble clic en una frase | Poner el cursor ahí / reproducir desde ahí |
| `N` | Añadir un bloque debajo del actual (`Ctrl+Enter` guarda, `Esc` cancela) |
| `M` | Abrir / cerrar tu micrófono real (si está activado) |
| `?` | Ayuda de atajos |

Cada bloque suena hasta el final y se detiene, dejando el cursor al principio del siguiente. Si te preguntan:
`Espacio` para pausar, respondes, haces clic en la frase desde la que quieres seguir y `Espacio` otra vez.
Con *Seguir al siguiente bloque* la reproducción no se detiene entre bloques.

### 3. Texto libre
Genera un único WAV de cualquier texto y lo puedes descargar. El reproductor permite desplazarse por el audio y
cambiar su velocidad sin modificar el WAV descargado. Se guarda en `~/frvoiceassist/outputs`.

### 4. Salida de audio (Teams / Meet)
Pulsa *Detectar dispositivos* y elige `CABLE Input`. En Teams/Meet elige `CABLE Output` como micrófono.
*Escucharme también* reproduce además por tus altavoces. La elección se recuerda.

- **Hablar con tu propia voz:** activa *Usar mi micrófono a través del cable*. La app mezcla tu micrófono real
  con la voz clonada. En la presentación, `M` lo abre y lo cierra. Empieza siempre cerrado y se silencia solo
  mientras suena la voz clonada.
- **Probar la cadena completa sin entrar en la reunión:** *▶ Probar voz clonada* y *🎙 Probar mi micrófono*
  graban lo que llega a `CABLE Output` y te lo dejan escuchar.

Guía completa: [docs/virtual-microphone.md](docs/virtual-microphone.md).

### Modos de clonado
- *Completo*: copia timbre, acento y ritmo de tu grabación.
- *Solo timbre*: copia solo el color de voz. Suele dar un inglés más neutro.

## API

Documentación interactiva en http://localhost:8765/docs.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/health` | Estado del modelo: `loading`, `ready` o `error` |
| GET/POST | `/api/voices` | Listar / crear voz (multipart: `name`, `transcript`, `audio`, `overwrite`) |
| POST | `/api/voices/{name}/check` | Re-comprobar la grabación (métricas + Whisper) |
| GET / DELETE | `/api/voices/{name}/audio`, `/api/voices/{name}` | Audio de referencia / eliminar |
| GET/POST | `/api/presentations` | Listar / crear presentación |
| GET/PUT/DELETE | `/api/presentations/{id}` | Leer / guardar / eliminar (con su audio) |
| DELETE | `/api/presentations/{id}/items/{item_id}` | Eliminar un bloque y su audio |
| GET | `/api/presentations/{id}/export.md` / `export.zip` | Exportar guion / presentación completa |
| POST | `/api/presentations/import` | Importar `.md` o `.zip` (multipart `file`) como presentación nueva |
| POST | `/api/script/parse` | Guion pegado (`# título` + texto) → bloques |
| POST | `/api/clips` | Audio de una frase (lo genera solo si no está en caché) → `{key, url, duration_s, cached}` |
| POST | `/api/clips/lookup` | Qué frases están ya generadas (no genera nada) |
| POST | `/api/clips/release` / `cleanup` | Borrar esos clips / todos los clips que ya no usa ninguna presentación |
| POST | `/api/tts` | Texto completo → `audio/wav` |
| GET | `/api/languages` | Idiomas soportados |

## Configuración

Todas las variables están en [.env.example](.env.example). Las más útiles:

| Variable | Defecto | Para qué |
|---|---|---|
| `FRVOICEASSIST_HOME` | `~/frvoiceassist` | Carpeta de datos personales |
| `PORT` | `8765` | Puerto de la web |
| `TTS_MODEL` | `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | También admite `Qwen/Qwen3-TTS-12Hz-0.6B-Base` |
| `TTS_ATTN` | `sdpa` | `flash_attention_2` si construyes con `INSTALL_FLASH_ATTN=true` |
| `QUALITY_STT` | `whisper` | `none` para desactivar el chequeo de la grabación |
| `TTS_ENGINE` | `qwen` | `fake` para probar la web sin GPU |

Tras cambiar `.env`: `docker compose up -d`. Si cambias `INSTALL_FLASH_ATTN`, reconstruye con `docker compose build`.

## Rendimiento

El tiempo de carga y generación depende del modelo, la GPU, los controladores y la plataforma. Para reducir
esperas durante una presentación, usa **Preparar audio** con antelación; la aplicación seguirá preparando las
frases siguientes en segundo plano. Las mejoras previstas están en la [hoja de ruta](docs/roadmap.md).

## Tests

Los tests no necesitan GPU ni modelo: usan un motor y un transcriptor falsos.

```powershell
docker compose --profile test run --rm tests              # en Docker

python -m venv .venv                                       # en local (Python 3.11+)
.\.venv\Scripts\pip install -r requirements.txt -r requirements-dev.txt
.\.venv\Scripts\python -m pytest
node --test tests/js/sentences.test.js                     # división en frases (JS, mismos casos que Python)
```

Test e2e de la interfaz con Chrome headless: ver [tests/e2e/README.md](tests/e2e/README.md).

Desarrollar la web sin GPU:
`$env:TTS_ENGINE="fake"; $env:QUALITY_STT="none"; .\.venv\Scripts\uvicorn app.main:main_app --factory --reload`

## Estructura

```
app/
  main.py            API FastAPI y rutas (factoría create_app / main_app)
  service.py         Síntesis: trocea, genera, concatena; caché de clips por frase
  presentations.py   Presentaciones (JSON en ~/frvoiceassist/presentations)
  presentation_io.py Exportar/importar (.md/.zip) y limpieza del audio que ya no se usa
  sentences.py       División en frases (idéntica a static/sentences.js)
  voices.py          Perfiles de voz (audio de referencia + transcripción)
  quality.py         Chequeo de la grabación (métricas + Whisper)
  config.py          Configuración desde variables de entorno
  text.py, audio.py  Troceado de texto y utilidades de audio
  tts/               Motores: qwen.py (real), fake.py (tests), base.py (interfaz)
  static/            Web sin dependencias: index.html, app.js, present.js, sentences.js
  resources/         Textos de referencia para grabar tu voz (EN/ES)
docker/Dockerfile    Imagen con CUDA + Qwen3-TTS + faster-whisper
docker-compose.yml   Servicio `tts` (GPU) y `tests` (perfil test)
scripts/             start.ps1, start.sh, check_gpu.py, smoke_test.ps1
tests/               pytest (+ tests/js con node --test)
docs/                Carpeta de datos, micrófono virtual, hoja de ruta
```

## Solución de problemas

- **`CUDA no disponible`**: actualiza el driver NVIDIA y Docker Desktop, y activa *Settings → Resources →
  WSL integration*. Prueba `docker run --rm --gpus all nvidia/cuda:12.8.0-base-ubuntu22.04 nvidia-smi`.
- **El puerto 8765 está ocupado**: cambia `PORT` en `.env`.
- **Falta VRAM (`CUDA out of memory`)**: cierra otras aplicaciones que usen la GPU o baja `TTS_CHUNK_CHARS`.
- **La voz no se parece**: mira el chequeo de calidad en *Mi voz*, prueba el modo *Solo timbre* o graba de nuevo.
- **Los atajos no responden**: haz clic en una zona vacía de la página. Si el foco está en un campo de texto
  o un desplegable, las teclas van a ese campo.
- **Linux: ficheros de root en `~/frvoiceassist`**: arranca con `scripts/start.sh`, que pasa tu UID/GID.
- **Modelo desde cero**: la caché está en el volumen `frvoiceassist_hf-cache` (`docker compose down -v` la borra).

## Uso responsable

Clona solo tu propia voz o voces con consentimiento expreso. Tus grabaciones son datos biométricos: se quedan
en tu PC (`~/frvoiceassist`), fuera del repo y de la imagen Docker.

Si presentas con una voz sintética, plantéate avisar a tu audiencia. Respeta las normas de tu organización
y de la plataforma de videoconferencia. Quien use este software es responsable de cómo lo usa.

## Licencia

[MIT](LICENSE) © 2026 Fran Moreno Santana.

El código de este repositorio es MIT. Las dependencias y los modelos que se descargan al construir o ejecutar
**no se redistribuyen aquí** y tienen sus propias licencias:

| Componente | Licencia |
|---|---|
| [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) (paquete `qwen-tts`) | Apache-2.0. Los pesos del modelo (Hugging Face) tienen la licencia indicada en su ficha. |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) y los modelos Whisper | MIT |
| PyTorch, FastAPI, NumPy, soundfile… | Ver cada proyecto |
| [VB-CABLE](https://vb-audio.com/Cable/) | Software de terceros (donationware), se instala aparte |

## Hoja de ruta

Ver [docs/roadmap.md](docs/roadmap.md): velocidad, y después hablar en español y que suene en inglés con tu voz.
