# Actas

Clon de Granola AI: graba tus reuniones, las transcribe **localmente** con Whisper y genera un acta en markdown (resumen, puntos clave, decisiones y pendientes) usando Claude Code con tu suscripción Max. Nada de audio sale de tu PC; solo la transcripción de texto se envía a Claude para el resumen.

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

o el acceso directo **Actas** del Escritorio.

## Opciones de notas (UI en inglés)

- **Note style**: General, Stand-up, 1:1, Client call, Brainstorm — cambia las secciones del acta.
- **Detail**: Concise (bullets cortos) o Detailed (exhaustivo).
- **Extra instructions**: contexto libre para Claude (asistentes, proyecto, en qué enfocarse).
- **↻ Regenerate**: rehace las notas de cualquier reunión guardada con otro estilo/detalle.
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

- `ACTAS_MODEL` — modelo de Whisper: `tiny`, `base`, `small` (default), `medium`. Más grande = más preciso pero más lento.
- `ACTAS_LANG` — fuerza el idioma de transcripción (`es`, `en`); por defecto se autodetecta.

## Notas

- La primera transcripción tras encender el PC tarda un poco más (carga del modelo).
- Si la reunión es larga, la transcripción en CPU puede tardar varios minutos; la app muestra el avance en vivo.
- El audio del sistema requiere Windows (Electron `audio: 'loopback'`).
