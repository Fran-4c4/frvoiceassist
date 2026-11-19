# Usar tu voz clonada como micrófono en Teams / Google Meet

No hace falta una aplicación de escritorio. El navegador (Chrome o Edge) puede reproducir el audio en
un dispositivo concreto, y un **cable de audio virtual** convierte esa salida en un micrófono que
Teams o Meet pueden elegir.

```
frvoiceassist ──► salida "CABLE Input" ══ cable virtual ══► micrófono "CABLE Output" ──► Teams / Meet
      └─(opcional) "Escucharme también" ──► tus altavoces o cascos
```

## 1. Instalar VB-CABLE (gratuito, una sola vez)

1. Descárgalo desde https://vb-audio.com/Cable/ (*VBCABLE_Driver_Pack*) y descomprímelo.
2. Ejecuta `VBCABLE_Setup_x64.exe` **como administrador** y pulsa *Install Driver*.
3. **Reinicia Windows.**
4. Comprueba que en *Configuración → Sistema → Sonido* aparecen **CABLE Input** (salida) y
   **CABLE Output** (entrada).

> No pongas CABLE Input como salida predeterminada de Windows, o todo el audio del sistema irá a la reunión.
> La app envía al cable solo su propio audio.

## 2. Configurar y probar en frvoiceassist

1. Abre http://localhost:8765 en Chrome o Edge y ve a la pestaña **Salida de audio**.
2. Pulsa **Detectar dispositivos** y acepta el permiso de micrófono. Sin él, el navegador no muestra los
   nombres de los dispositivos.
3. En *Dispositivo de salida* elige **CABLE Input (VB-Audio Virtual Cable)**. La elección se recuerda.
4. En **Probar el micrófono virtual**, el micrófono **CABLE Output** se selecciona solo. Pulsa **▶ Probar**:
   - la app reproduce una frase con tu voz por CABLE Input;
   - a la vez escucha CABLE Output, que es lo mismo que oirá Teams/Meet, y mide el nivel;
   - te da un veredicto (✓ funciona / ⚠ dudoso / ✗ no llega audio);
   - puedes **escuchar la grabación**: es exactamente lo que recibirá la reunión.
5. Activa **Escucharme también** si quieres oír por tus cascos lo que se envía.

Si da ✗:
- Comprueba que la salida es *CABLE Input* y el micrófono de la prueba es *CABLE Output*.
- En *Configuración → Sistema → Sonido → CABLE Output*, comprueba que no está desactivado y que el volumen no
  está a 0.
- Si acabas de instalar VB-CABLE, reinicia Windows y recarga la página.

## 3. Configurar la reunión

**Teams** (nuevo Teams):
1. *Configuración → Dispositivos → Micrófono →* **CABLE Output**.
2. *Supresión de ruido →* **Desactivada** o **Baja**. La supresión fuerte puede recortar la voz sintética.
3. *Hacer una llamada de prueba*: graba unos segundos y te los reproduce. Mientras graba, reproduce una frase
   desde la app y comprueba que se oye en la grabación.

**Google Meet**:
1. Antes de entrar, en la pantalla de la cámara: *⋮ → Configuración → Audio → Micrófono →* **CABLE Output**.
2. La barra de nivel junto al micrófono debe moverse al reproducir una frase desde la app.
3. Para oír cómo suena, puedes abrir una reunión de prueba desde otro dispositivo o cuenta.

## Hablar con tu propia voz durante la presentación

Mientras Teams/Meet escuche CABLE Output, tu micrófono real no llega a la reunión. La app lo resuelve
**mezclando tu micrófono con la voz clonada** antes de enviarlo al cable:

```
voz clonada ─┐
             ├─► mezcla en el navegador ─► CABLE Input ══► CABLE Output ─► Teams / Meet
tu micro ────┘
```

1. En **Salida de audio → Hablar con tu micrófono durante la presentación**, marca *Usar mi micrófono a través
   del cable* y elige tu micrófono real (p. ej. el del Jabra).
2. Durante la presentación pulsa **`M`** (o el botón 🎙 de la barra) para abrirlo y **`M`** otra vez para cerrarlo.
   - 🔴 **MICRO ABIERTO**: la reunión te oye. El título de la pestaña también lo indica.
   - **Empieza siempre cerrado**, también al recargar la página.
   - Con *Silenciarlo mientras suena la voz clonada* (activado por defecto), el micro se calla solo mientras
     habla tu voz clonada y se reabre al terminar. Así no se solapan ni hay eco.
3. **Usa cascos.** Si el micrófono capta tus altavoces, la reunión oirá eco o la voz clonada dos veces.
4. Compruébalo con **🎙 Probar mi micrófono**: abre tu micro 4 segundos, graba lo que llega a CABLE Output y
   te lo deja escuchar.

Tu voz real pasa por la cancelación de eco y de ruido del navegador, como en una llamada normal.

> Alternativa sin la app: VoiceMeeter Banana (de los autores de VB-CABLE) mezcla cualquier micrófono y
> cualquier aplicación, pero hay que configurarlo aparte.

## Antes de cada reunión

- **Prepara el audio con antelación.** Generar es lento; las frases preparadas suenan al instante.
- **Prueba** con **▶ Probar voz clonada** y **🎙 Probar mi micrófono**. Tarda unos segundos y evita sorpresas.
- La pestaña de frvoiceassist debe seguir abierta durante la reunión: es la que envía el audio al cable.
