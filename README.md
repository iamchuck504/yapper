# Yapper

Clon de Granola AI: graba tus reuniones, las transcribe **localmente** con Whisper y genera un acta en markdown (resumen, puntos clave, decisiones y pendientes) usando Claude Code con tu suscripción Max. Nada de audio sale de tu PC; solo la transcripción de texto se envía a Claude para el resumen.

## En vivo (estilo Granola)

- **Transcripción en streaming.** El renderer manda PCM continuo; `live.js` mantiene un buffer rodante de 12 s y lo re-transcribe cada ~0.7 s. Una palabra solo se "confirma" cuando dos pasadas seguidas coinciden (LocalAgreement-2); la cola tentativa se muestra atenuada y se corrige sola. Las pausas largas abren párrafo nuevo.
- **Qué tan atrás va.** Medido reproduciendo un minuto de reunión real a velocidad de reloj en una RTX 4080 SUPER: **2.6 s de mediana** entre lo que se dice y lo que queda confirmado (peor caso 4.8 s). La cola tentativa aparece antes, cerca de 1 s. Una válvula de seguridad confirma lo que lleve más de 1.5 s sin acuerdo, para que un pasaje difícil no congele el transcript.
- **Burbuja flotante.** Ventana pequeña siempre visible, arrastrable, que sigue el tema claro/oscuro. Se **colapsa a un indicador compacto** (barras animadas + cronómetro) y se expande al transcript completo con un clic. Toggle "Floating bubble".
- **Auto-detección de reuniones.** Detecta qué app está usando el micrófono (Zoom, Teams, Slack, Discord, Webex y llamadas en el navegador: Meet/Hangouts) y **manda una notificación del sistema**: un clic empieza a grabar, sin tener que ir a buscar la ventana. Cuando Yapper ya está enfrente, el aviso aparece dentro de la app. Toggle "Auto-detect meetings". Solo Windows por ahora; en Mac llega con el rework de audio.

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

## Quién escribe las notas

La transcripción es siempre local. Las notas no, y no todo el mundo paga un modelo igual, así que el proveedor se elige en la app (**Notes by**):

| Proveedor | Qué necesita | Costo |
|---|---|---|
| **Claude Code** | el CLI instalado y con sesión (la suscripción Max) | incluido |
| **Google Gemini** | key gratis de [aistudio.google.com](https://aistudio.google.com/apikey), **sin tarjeta**, ~1 min | gratis |
| **OpenRouter** | key propia; sus modelos `:free` no cobran | gratis o de pago |
| **Ollama** | Ollama instalado en la misma máquina | gratis y privado |
| **Anthropic API** | key propia de console.anthropic.com | de pago |
| **Other (OpenAI-compatible)** | cualquier endpoint que hable `/chat/completions` | según el endpoint |

Esa última fila es a propósito la salida hacia adelante: si esto termina siendo un producto con una API oficial, se agrega una entrada en `llm.js` y ya — los tres lugares que generan notas (resumen, regenerar, título automático) no se tocan.

**Por qué no hay una opción de cero configuración.** No existe. Toda API hospedada necesita una credencial, y esa credencial sale de uno de tres lugares: metida dentro de la app (la abusan en días y viola los términos de cualquier proveedor), servida por un backend que alguien paga, o la del propio usuario. Lo más cerca que se puede llegar honestamente es **Gemini**: gratis, sin tarjeta, y sacar la key toma alrededor de un minuto. La única alternativa realmente sin credencial es correr el modelo localmente — de ahí la opción de **Ollama** para quien ya lo tenga.

**Ojo con los planes gratis:** casi todos entrenan con lo que les mandas. La app lo dice en pantalla al elegirlos, porque una transcripción de reunión no siempre es tuya para compartir. Para reuniones confidenciales, Claude Code, la API de pago u Ollama.

Si el modelo configurado deja de existir (los proveedores retiran ids), **Test connection** le pregunta al endpoint qué modelos sí tiene y los lista en el error, en vez de dejarte adivinando.

La key se guarda **cifrada con el llavero del sistema** (DPAPI en Windows, Keychain en macOS), no en texto plano dentro de `settings.json`, y nunca sale del proceso principal: el renderer solo se entera de si hay una o no. Si el sistema no tiene llavero, la app lo dice en vez de fingir que está protegida.

Hay un botón **Test connection** que hace una llamada mínima y responde "working" o el error real (key rechazada, sin saldo, modelo inexistente).

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

Una nota de voz importada recibe **el mismo trato que una reunión grabada**: transcripción, notas y título automático. Si el archivo se llama algo genérico (`recording`, `New Recording 3`, `WhatsApp Audio…`, o solo una fecha), el título lo pone el modelo según lo que se habló, en vez de llamar a la reunión "recording".

Medido con archivos reales: un `.m4a` de 2.5 min tarda 3 s en total; un `.webm` de 24 min, 27 s.

## Uso

```
npm start
```

o el acceso directo **Yapper** del Escritorio.

## Opciones de notas (UI en inglés)

- **Note style**: General, Minutes, **Memo**, Stand-up, 1:1, Client call, Brainstorm — cambia las secciones del acta. *Memo* está pensado para reenviar a alguien que no estuvo: prosa en vez de viñetas, lenguaje neutro, y dice explícitamente cuando algo se discutió pero no se decidió.
- **Detail**: Concise (bullets cortos) o Detailed (exhaustivo).
- **Extra instructions**: contexto libre para Claude (asistentes, proyecto, en qué enfocarse).
- **Participants**: los nombres se le pasan a Whisper como prompt inicial, así deja de escribir "Ninfa" como "Nympho". Es un dato **de esa reunión**, no una preferencia: el campo arranca vacío cada vez, para que los nombres de la semana pasada no se cuelen en el acta de hoy.
- **Borrar reuniones**: cada fila de la barra lateral tiene una papelera que aparece al pasar el cursor. Las grabaciones fallidas (sin audio) se ven atenuadas y etiquetadas *Empty recording*. Siempre pregunta antes, enumerando lo que contiene, y va a la papelera del sistema — nunca borra audio de forma irreversible.
- **↻ Regenerate**: rehace las notas de cualquier reunión guardada con otro estilo/detalle.
- **Título automático**: si no escribes título, Claude nombra la reunión según lo que se habló (2-6 palabras); si la grabación no da para tanto, cae a la fecha.
- **Export** (menú): notas en PDF, notas en Markdown, **transcripción completa en Markdown** (marcas de tiempo en negrita, párrafo nuevo tras un minuto de silencio), transcripción en .txt, o notas + transcripción en un solo .md.
- **Start with Windows**: arranca Yapper al iniciar sesión (encendido por defecto, se apaga desde el toggle).
- Las notas salen **en inglés** y se muestran como tarjetas con código de color: Summary (violeta), Key points (cian), Decisions (verde), Action items (ámbar), Open questions (rosa), Blockers/Risks (rojo), Next steps (teal).

## Compartir con compañeros

1. Copia la carpeta del proyecto (sin `node_modules`, `bin` ni `models` si quieres que pese poco: setup los baja).
2. En la PC nueva: instala Node (`winget install OpenJS.NodeJS.LTS`) si no está.
3. Corre `powershell -ExecutionPolicy Bypass -File setup.ps1` — baja el motor de whisper.cpp (y la build CUDA si hay GPU NVIDIA), los modelos, instala Electron y crea el acceso directo.
4. Para las notas cada quien elige su proveedor en la app: su propia sesión de Claude Code, o su propia key. La grabación y la transcripción funcionan sin nada de eso.

La app avisa al arrancar si falta algún requisito. Si una transcripción falla o se interrumpe, la grabación nunca se pierde: la reunión queda como "not transcribed" en la sidebar y un botón **Transcribe now** la recupera.

## Requisitos

- Node + Electron (en `node_modules`)
- whisper.cpp en `bin/` y modelos en `models/` (los baja `setup.ps1`)
- Para las notas: Claude Code con sesión iniciada, **o** una API key en ajustes

## Configuración opcional (variables de entorno)

- `YAPPER_LANG` — fuerza el idioma de transcripción (`es`, `en`); por defecto se autodetecta.
- `YAPPER_LIVE_DEBUG=1` — imprime una línea por pasada del vivo (costo, tamaño del buffer, cuántas palabras coincidieron y cuántas se confirmaron).

## Pruebas

```
npm test                          # todo lo que corre sin modelo ni GPU
```

```
node build\test-llm.js            # proveedores de notas, contra un servidor falso
node build\test-keystore.js       # la key no queda legible (con electron usa el llavero real)
node build\test-live-logic.js     # reglas de confirmación del vivo
node build\test-meetings.js       # el borrado no puede salirse de la carpeta de reuniones
node build\test-section-coverage.js  # cada estilo tiene botón y cada sección tiene color
node build\test-ipc-wiring.js     # todo canal del preload tiene contraparte
node build\test-bounds.js         # la burbuja nunca sale de la pantalla
node build\test-engine.js         # arranca el servidor y mide una pasada
node build\test-steady-cpu.js     # el nivel steady se sostiene sin GPU
node build\tune-live.js           # replay de audio real comparando configuraciones
```

Los que abren ventana van con Electron:

```
node_modules\electron\dist\electron.exe build\test-bubble-fit.js
node_modules\electron\dist\electron.exe build\test-keystore.js
node_modules\electron\dist\electron.exe build\test-llm-ui.js
node_modules\electron\dist\electron.exe build\test-delete-ui.js
node_modules\electron\dist\electron.exe build\test-options-ui.js
node_modules\electron\dist\electron.exe build\test-import.js
node_modules\electron\dist\electron.exe build\test-memo.js
node_modules\electron\dist\electron.exe build\test-styles.js
node_modules\electron\dist\electron.exe build\test-stamps.js
```

Los que arrancan la app lo hacen contra carpetas temporales, nunca contra tus reuniones reales. `test-llm-ui.js` guarda una key y comprueba que no aparece ni en `settings.json` ni de vuelta en el renderer; `test-delete-ui.js` verifica que cancelar no borra, que se borra solo la fila elegida y que el aviso enumera lo que se perdería; `test-import.js` importa un `.m4a` y un `.webm` reales y revisa que el WAV resultante sea de verdad reproducible (cabecera, 16 kHz mono, y que no salga en silencio).

`test-memo.js`, `test-styles.js` y `test-stamps.js` sí gastan llamadas al modelo. `test-styles.js` es el chequeo de coherencia: corre **cada** estilo contra la misma transcripción y compara las secciones que devuelve con las que ese estilo pidió — que no invente ninguna, que empiece por la que corresponde, y que la interfaz sepa colorearlas todas. Fue el que descubrió que *Minutes* devolvía las secciones sin marca de tiempo; `test-stamps.js` repite los estilos más propensos varias veces para confirmar que ya no pasa.

Ojo: escriben el avance a un `progress.log` además de a stdout, porque Electron en Windows no vacía su salida hasta que el proceso termina, y una corrida de siete llamadas al modelo tarda unos diez minutos.

## Notas

- La primera transcripción tras encender el PC tarda un poco más (carga del modelo).
- Si la reunión es larga, la transcripción en CPU puede tardar varios minutos; la app muestra el avance en vivo.
- El audio del sistema requiere Windows (Electron `audio: 'loopback'`).
