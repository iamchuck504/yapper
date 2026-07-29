# Yapper

Clon de another meeting-notes app AI: graba tus reuniones, las transcribe **localmente** con Whisper y genera un acta en markdown (resumen, puntos clave, decisiones y pendientes) usando Claude Code con tu suscripción Max. Nada de audio sale de tu PC; solo la transcripción de texto se envía a Claude para el resumen.

## En vivo (estilo another meeting-notes app)

- **Transcripción en streaming (~1-2 s de retraso).** El renderer envía PCM continuo a un worker persistente (`transcribe_stream.py`) que mantiene un buffer rodante y re-transcribe cada ~0.7 s. Una palabra solo se "confirma" cuando dos pasadas seguidas coinciden (LocalAgreement-2); la cola tentativa se muestra atenuada y se va corrigiendo sola. Las pausas largas abren párrafo nuevo.
- **Modelo del vivo:** con GPU usa `medium` (~0.3 s por pasada en una RTX 4080, más preciso); sin GPU baja solo a `small`. Configurable con `YAPPER_LIVE_MODEL`.
- **Burbuja flotante.** Ventana pequeña siempre visible, arrastrable, que sigue el tema claro/oscuro. Se **colapsa a un indicador compacto** (barras animadas + cronómetro) y se expande al transcript completo con un clic. Toggle "Floating bubble".
- **Auto-detección de reuniones.** Detecta qué app está usando el micrófono (Zoom, Teams, Slack, Discord, Webex y llamadas en el navegador: Meet/Hangouts) y ofrece tomar notas con un aviso discreto. Toggle "Auto-detect meetings". Solo Windows por ahora; en Mac llega con el rework de audio.

El preview en vivo es *solo un adelanto*: al detener, la transcripción final se rehace con una pasada completa de alta calidad, y de ahí salen las notas.

## Cómo funciona

1. **Grabar reunión** — captura el audio del sistema (lo que escuchas: Meet, Zoom, Teams…) por loopback de Windows **y** tu micrófono, mezclados en un solo audio.
2. **Detener y resumir** — transcribe con faster-whisper (modelo `small`, CPU, gratis) y luego invoca `claude -p` para generar el acta.
3. Cada reunión queda en `Documentos\Reuniones\AAAA-MM-DD_HHMM\`:
   - `grabacion.webm` — el audio
   - `transcripcion.txt` — la transcripción con marcas de tiempo
   - `resumen.md` — el acta generada
4. La barra lateral lista las reuniones anteriores; clic para volver a ver el acta.

## Uso

```
npm start
```

o el acceso directo **Yapper** del Escritorio.

## Opciones de notas (UI en inglés)

- **Note style**: General, Stand-up, 1:1, Client call, Brainstorm — cambia las secciones del acta.
- **Detail**: Concise (bullets cortos) o Detailed (exhaustivo).
- **Extra instructions**: contexto libre para Claude (asistentes, proyecto, en qué enfocarse).
- **↻ Regenerate**: rehace las notas de cualquier reunión guardada con otro estilo/detalle.
- **Título automático**: si no escribes título, Claude nombra la reunión según lo que se habló (2-6 palabras); si la grabación no da para tanto, cae a la fecha.
- **Export** (menú): notas en PDF, notas en Markdown, transcripción completa en .txt, o notas + transcripción en un solo .md.
- **Start with Windows**: arranca Yapper al iniciar sesión (encendido por defecto, se apaga desde el toggle).
- Las notas salen **en inglés** y se muestran como tarjetas con código de color: Summary (violeta), Key points (cian), Decisions (verde), Action items (ámbar), Open questions (rosa), Blockers/Risks (rojo), Next steps (teal).

## Compartir con compañeros

1. Copia la carpeta del proyecto (sin `node_modules` si quieres que pese poco).
2. En la PC nueva: instala Node (`winget install OpenJS.NodeJS.LTS`) y Python (`winget install Python.Python.3.12`) si no están.
3. Corre `powershell -ExecutionPolicy Bypass -File setup.ps1` — instala faster-whisper, detecta GPU NVIDIA (y si hay, CUDA), descarga el modelo, instala Electron y crea el acceso directo.
4. Para la generación de notas cada quien necesita **su propia** sesión de Claude Code (claude.com/code). La transcripción funciona sin Claude.

La app avisa al arrancar si falta algún requisito. Si una transcripción falla o se interrumpe, la grabación nunca se pierde: la reunión queda como "not transcribed" en la sidebar y un botón **Transcribe now** la recupera.

## Requisitos

- Node + Electron (en `node_modules`)
- Python con `faster-whisper` (`pip install faster-whisper`)
- Claude Code CLI con sesión iniciada (`claude`)

## Configuración opcional (variables de entorno)

- `YAPPER_MODEL` — modelo de Whisper: `tiny`, `base`, `small` (default), `medium`. Más grande = más preciso pero más lento.
- `YAPPER_LANG` — fuerza el idioma de transcripción (`es`, `en`); por defecto se autodetecta.

## Notas

- La primera transcripción tras encender el PC tarda un poco más (carga del modelo).
- Si la reunión es larga, la transcripción en CPU puede tardar varios minutos; la app muestra el avance en vivo.
- El audio del sistema requiere Windows (Electron `audio: 'loopback'`).
