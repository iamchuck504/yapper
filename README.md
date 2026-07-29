# Yapper

Clon de Granola AI: graba tus reuniones, las transcribe **localmente** con Whisper y genera un acta en markdown (resumen, puntos clave, decisiones y pendientes) usando Claude Code con tu suscripción Max. Nada de audio sale de tu PC; solo la transcripción de texto se envía a Claude para el resumen.

## En vivo (estilo Granola)

- **Transcripción en streaming.** El renderer manda PCM continuo; `live.js` mantiene un buffer rodante de 12 s y lo re-transcribe cada ~0.7 s. Una palabra solo se "confirma" cuando dos pasadas seguidas coinciden (LocalAgreement-2); la cola tentativa se muestra atenuada y se corrige sola. Las pausas largas abren párrafo nuevo.
- **Qué tan atrás va.** Medido reproduciendo un minuto de reunión real a velocidad de reloj en una RTX 4080 SUPER: **2.6 s de mediana** entre lo que se dice y lo que queda confirmado (peor caso 4.8 s). La cola tentativa aparece antes, cerca de 1 s. Una válvula de seguridad confirma lo que lleve más de 1.5 s sin acuerdo, para que un pasaje difícil no congele el transcript.
- **Burbuja flotante.** Ventana pequeña siempre visible, arrastrable, que sigue el tema claro/oscuro. Se **colapsa a un indicador compacto** (barras animadas + cronómetro) y se expande al transcript completo con un clic. Toggle "Floating bubble".
- **Auto-detección de reuniones.** Detecta qué app está usando el micrófono (Zoom, Teams, Slack, Discord, Webex y llamadas en el navegador: Meet/Hangouts) y ofrece tomar notas con un aviso discreto. Toggle "Auto-detect meetings". Solo Windows por ahora; en Mac llega con el rework de audio.

El preview en vivo es *solo un adelanto*: al detener, la transcripción final se rehace con una pasada completa de más calidad, y de ahí salen las notas.

## El motor y los niveles

La transcripción corre sobre **whisper.cpp** (`whisper-server` en localhost). No hay Python, ni módulos nativos de Node que haya que recompilar por plataforma: son binarios sueltos y modelos `.bin`.

La primera vez que arranca, Yapper **mide esta máquina** en vez de adivinar por marca: corre unas pasadas de 10 s y guarda el resultado en ajustes.

Anclas medidas en la misma PC con la muestra de calibración: RTX 4080 SUPER **75 ms**, i7-12700K solo CPU **736 ms**.

| Nivel | Cuándo | Vivo | Final | Retraso medido |
|---|---|---|---|---|
| `fast` | pasada de `base` ≤ 250 ms (GPU) | `small`, cada 0.7 s | `small` | 2.6 s |
| `steady` | ≤ 1200 ms | `base`, cada 2 s | `small` | 4.4 s |
| `modest` | más lento | sin vivo | `small` | — |

**`medium` no se usa en ningún lado**, aunque en papel transcribe mejor. En vivo sus pasadas son tan lentas que dos ventanas seguidas ya no coinciden y se confirma menos texto. Y en la pasada final entra en bucles de repetición con audio real de reunión: en un minuto de un huddle ruidoso devolvió *"I'm not asking you to do it. I actually very much"* seis veces seguidas, con y sin beam search, donde `small` transcribió lo mismo limpio. Con voz limpia (la muestra de JFK) los dos van bien; las reuniones no son voz limpia.

Si una máquina resulta más lenta de lo que midió (batería, CPU ocupada, otra app en la GPU), el vivo **estira solo su cadencia** en vez de irse quedando cada vez más atrás.

## Cómo funciona

1. **Grabar reunión** — captura el audio del sistema (lo que escuchas: Meet, Zoom, Teams…) por loopback de Windows **y** tu micrófono, mezclados en un solo audio.
2. El audio se escribe a disco **según llega**, ya en el formato que consume el transcriptor (WAV 16 kHz mono). Si se va la luz a media reunión, lo grabado hasta ese momento se reproduce y se transcribe igual.
3. **Detener y resumir** — pasada completa de whisper.cpp por ventanas, y luego `claude -p` para generar el acta.
4. Cada reunión queda en `Documents\Meetings\AAAA-MM-DD_HHMM\`:
   - `recording.wav` — el audio
   - `transcript.txt` — la transcripción con marcas de tiempo
   - `notes.md` — el acta generada
5. La barra lateral lista las reuniones anteriores; clic para volver a ver el acta.

## Importar notas de voz

Cualquier formato que Chromium sepa decodificar (mp3, m4a, opus, flac, ogg, wav, mp4…) se convierte dentro de la app al WAV que usa el transcriptor. No hace falta ffmpeg ni ninguna dependencia extra: los códecs ya vienen dentro de Electron.

## Uso

```
npm start
```

o el acceso directo **Yapper** del Escritorio.

## Opciones de notas (UI en inglés)

- **Note style**: General, Stand-up, 1:1, Client call, Brainstorm — cambia las secciones del acta.
- **Detail**: Concise (bullets cortos) o Detailed (exhaustivo).
- **Extra instructions**: contexto libre para Claude (asistentes, proyecto, en qué enfocarse).
- **Participants**: los nombres se le pasan a Whisper como prompt inicial, así deja de escribir "Ninfa" como "Nympho".
- **↻ Regenerate**: rehace las notas de cualquier reunión guardada con otro estilo/detalle.
- **Título automático**: si no escribes título, Claude nombra la reunión según lo que se habló (2-6 palabras); si la grabación no da para tanto, cae a la fecha.
- **Export** (menú): notas en PDF, notas en Markdown, transcripción completa en .txt, o notas + transcripción en un solo .md.
- **Start with Windows**: arranca Yapper al iniciar sesión (encendido por defecto, se apaga desde el toggle).
- Las notas salen **en inglés** y se muestran como tarjetas con código de color: Summary (violeta), Key points (cian), Decisions (verde), Action items (ámbar), Open questions (rosa), Blockers/Risks (rojo), Next steps (teal).

## Compartir con compañeros

1. Copia la carpeta del proyecto (sin `node_modules`, `bin` ni `models` si quieres que pese poco: setup los baja).
2. En la PC nueva: instala Node (`winget install OpenJS.NodeJS.LTS`) si no está.
3. Corre `powershell -ExecutionPolicy Bypass -File setup.ps1` — baja el motor de whisper.cpp (y la build CUDA si hay GPU NVIDIA), los modelos, instala Electron y crea el acceso directo.
4. Para la generación de notas cada quien necesita **su propia** sesión de Claude Code (claude.com/code). La transcripción funciona sin Claude.

La app avisa al arrancar si falta algún requisito. Si una transcripción falla o se interrumpe, la grabación nunca se pierde: la reunión queda como "not transcribed" en la sidebar y un botón **Transcribe now** la recupera.

## Requisitos

- Node + Electron (en `node_modules`)
- whisper.cpp en `bin/` y modelos en `models/` (los baja `setup.ps1`)
- Claude Code CLI con sesión iniciada (`claude`)

## Configuración opcional (variables de entorno)

- `YAPPER_LANG` — fuerza el idioma de transcripción (`es`, `en`); por defecto se autodetecta.
- `YAPPER_LIVE_DEBUG=1` — imprime una línea por pasada del vivo (costo, tamaño del buffer, cuántas palabras coincidieron y cuántas se confirmaron).

## Pruebas

```
node build\test-live-logic.js     # reglas de confirmación (sin modelo)
node build\test-bounds.js         # la burbuja nunca sale de la pantalla
node build\test-engine.js         # arranca el servidor y mide una pasada
node build\tune-live.js           # replay de audio real comparando configuraciones
```

## Notas

- La primera transcripción tras encender el PC tarda un poco más (carga del modelo).
- Si la reunión es larga, la transcripción en CPU puede tardar varios minutos; la app muestra el avance en vivo.
- El audio del sistema requiere Windows (Electron `audio: 'loopback'`).
