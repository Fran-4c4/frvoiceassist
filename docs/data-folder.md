# Carpeta de datos personales

Todo lo personal vive **fuera del repositorio**, en tu home:

| Sistema | Ruta |
|---|---|
| Windows | `C:\Users\<usuario>\frvoiceassist` |
| Linux / macOS | `~/frvoiceassist` |

Puedes cambiarla con `FRVOICEASSIST_HOME` en `.env`. Docker Compose la monta en `/workspace` dentro del contenedor.

```
frvoiceassist/
  voices/                 # tus voces de referencia (datos biométricos)
    me/
      reference.wav       # tu voz, 10-20 s (mín. 3 s, máx. 60 s), mono 24 kHz
      reference.txt       # transcripción EXACTA de lo que dices en reference.wav
      quality.json        # último chequeo de calidad (lo genera la app)
  presentations/          # tus presentaciones (un JSON por presentación)
  outputs/                # audios generados en "Texto libre"
  cache/clips/            # audio por frase de las presentaciones (se puede borrar: se regenera)
```

## Voces

La forma más sencilla de crearlas es la pestaña **Mi voz** de la web, pero también puedes copiar a mano
`reference.wav` y `reference.txt`.

Consejos para un buen clonado:

- Graba con el tono y el ritmo con el que vas a presentar. Puede ser en inglés o en español.
- Habitación silenciosa, sin eco ni música, micrófono a unos 15 cm, sin saturar.
- La transcripción debe coincidir palabra por palabra, incluidas las muletillas si las dices.
  El chequeo de calidad te avisa si Whisper oye algo distinto.
- Puedes tener varias voces (p. ej. `me-en`, `me-es`) y elegirlas en la web.

## Copias de seguridad

Copia la carpeta entera. `cache/` no hace falta, porque se regenera.

> Las voces son datos biométricos: no las compartas ni las subas a repositorios.
