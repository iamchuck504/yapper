const $ = id => document.getElementById(id);

const viewRecord = $('view-record');
const viewMeeting = $('view-meeting');
const viewReminders = $('view-reminders');
const btnRecord = $('btn-record');
const btnStop = $('btn-stop');
const btnNew = $('btn-new');
const btnRegen = $('btn-regen');
const btnCopy = $('btn-copy');
const btnOpenFolder = $('btn-open-folder');
const recLive = $('rec-live');
const timerEl = $('timer');
const statusEl = $('status');
const regenStatusEl = $('regen-status');
const pipelineEl = $('pipeline');
const vizSys = $('viz-sys');
const vizMic = $('viz-mic');
const titleInput = $('meeting-title');
const customInput = $('custom-instructions');
const notesEl = $('notes');
const transcriptEl = $('transcript');
const resultTitle = $('result-title');
const meetingList = $('meeting-list');
const regenStyle = $('regen-style');
const regenDetail = $('regen-detail');

let recorder = null;
let chunks = [];
let audioCtx = null;
let dest = null;          // MediaStreamDestination feeding the recorder
let micBus = null;        // GainNode summing all active mics
let sysGainNode = null;   // GainNode for system audio
let micHP = null;         // high-pass filter (cuts low rumble/hum)
let micLP = null;         // low-pass filter (tames hiss on Strong)
let sysStream = null;     // system-audio loopback stream

let noiseReduction = localStorage.getItem('actas-noise') || 'standard';

const numOr = (v, d) => (isNaN(parseFloat(v)) ? d : parseFloat(v));
let gainSys = numOr(localStorage.getItem('actas-gain-sys'), 1);
let gainMic = numOr(localStorage.getItem('actas-gain-mic'), 1);
const micStreams = new Map(); // deviceId|'default' -> MediaStream
const micNodes = new Map();   // deviceId|'default' -> MediaStreamAudioSourceNode
let analysers = { sys: null, mic: null };
let segRecorder = null;   // cycled recorder producing ~20s segments for live preview
let segTimeout = null;
let liveActive = false;
const LIVE_SEGMENT_MS = 20000;
let timerInterval = null;
let levelRaf = null;
let currentFolder = null;
let currentNotesMd = '';
let resultDateStr = '';
let allMeetings = [];
let searchQuery = '';

const resultDate = $('result-date');
const searchInput = $('search');
const btnSpeak = $('btn-speak');
const voiceSelect = $('voice-select');

const micSelect = $('mic-select');
let micSelection = localStorage.getItem('actas-mic') || 'default';

const liveWrap = $('live-wrap');
const liveTranscriptEl = $('live-transcript');

// ---------- theme (persisted) ----------

const btnTheme = $('btn-theme');
let theme = localStorage.getItem('actas-theme') || 'dark';

function applyTheme() {
  document.body.classList.toggle('light', theme === 'light');
}

btnTheme.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('actas-theme', theme);
  applyTheme();
});

applyTheme();

// ---------- note options (persisted) ----------

const participantsRec = $('participants-rec');
const participantsMeet = $('participants-meet');

const options = Object.assign(
  { style: 'general', detail: 'concise', custom: '', participants: '' },
  JSON.parse(localStorage.getItem('actas-options') || '{}')
);

function saveOptions() {
  options.custom = customInput.value;
  options.participants = participantsRec.value;
  localStorage.setItem('actas-options', JSON.stringify(options));
}

function syncOptionControls() {
  document.querySelectorAll('#style-pills .seg-btn').forEach(p =>
    p.classList.toggle('active', p.dataset.style === options.style));
  document.querySelectorAll('#detail-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.detail === options.detail));
  document.querySelectorAll('#noise-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.noise === noiseReduction));
  customInput.value = options.custom || '';
  participantsRec.value = options.participants || '';
  regenStyle.value = options.style;
  regenDetail.value = options.detail;
}

document.querySelectorAll('#style-pills .seg-btn').forEach(p =>
  p.addEventListener('click', () => { options.style = p.dataset.style; saveOptions(); syncOptionControls(); }));
document.querySelectorAll('#detail-seg .seg-btn').forEach(b =>
  b.addEventListener('click', () => { options.detail = b.dataset.detail; saveOptions(); syncOptionControls(); }));
document.querySelectorAll('#noise-seg .seg-btn').forEach(b =>
  b.addEventListener('click', () => { setNoiseReduction(b.dataset.noise); syncOptionControls(); }));
customInput.addEventListener('change', saveOptions);
participantsRec.addEventListener('change', saveOptions);
regenStyle.addEventListener('change', () => { options.style = regenStyle.value; saveOptions(); syncOptionControls(); });
regenDetail.addEventListener('change', () => { options.detail = regenDetail.value; saveOptions(); syncOptionControls(); });

// ---------- helpers ----------

function showView(name) {
  viewRecord.classList.toggle('hidden', name !== 'record');
  viewMeeting.classList.toggle('hidden', name !== 'meeting');
  viewReminders.classList.toggle('hidden', name !== 'reminders');
  $('btn-reminders').classList.toggle('active', name === 'reminders');
}

function setStatus(el, text, isError = false) {
  el.classList.remove('hidden');
  el.classList.toggle('error', isError);
  el.textContent = text;
  el.scrollTop = el.scrollHeight;
}

function setStep(step, state) {
  const el = pipelineEl.querySelector(`[data-step="${step}"]`);
  if (el) { el.classList.remove('active', 'done', 'error'); if (state) el.classList.add(state); }
}

function resetPipeline() {
  pipelineEl.querySelectorAll('.step').forEach(s => s.classList.remove('active', 'done', 'error'));
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatMeetingDate(name) {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(?:_\d+)?$/);
  if (!m) return name;
  return `${m[3]}/${m[2]}/${m[1]} · ${m[4]}:${m[5]}`;
}

// ---------- markdown → color-coded section cards ----------

const SECTION_META = [
  { match: /summary|tl;?dr|highlight|recap|overview/i, cls: 'sec-summary' },
  { match: /key point|topic|discussion|discussed/i, cls: 'sec-key' },
  { match: /decision|agreement/i, cls: 'sec-decision' },
  { match: /action|commitment/i, cls: 'sec-action' },
  { match: /question|feedback/i, cls: 'sec-question' },
  { match: /blocker|risk|concern/i, cls: 'sec-risk' },
  { match: /next step|plan/i, cls: 'sec-next' },
  { match: /update|progress/i, cls: 'sec-key' },
  { match: /idea/i, cls: 'sec-summary' },
  { match: /client|need/i, cls: 'sec-key' }
];

function sectionMeta(title) {
  for (const m of SECTION_META) if (m.match.test(title)) return m;
  return { cls: 'sec-neutral' };
}

function inlineMd(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

function bodyToHtml(lines) {
  let html = '';
  let inList = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^[-*•] /.test(t)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inlineMd(t.slice(2))}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (/^#{3,4} /.test(t)) html += `<h3>${inlineMd(t.replace(/^#+ /, ''))}</h3>`;
    else if (t) html += `<p>${inlineMd(t)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

function renderNotes(md) {
  currentNotesMd = md || '';
  notesEl.innerHTML = '';
  if (!md || !md.trim()) {
    notesEl.innerHTML = '<div class="note-card sec-neutral"><p>No notes yet — this meeting only has a verbatim transcript. Use Regenerate to create notes from it.</p></div>';
    return;
  }
  const sections = [];
  let cur = { title: '', body: [] };
  for (const line of md.split('\n')) {
    const m = line.match(/^##\s+(.*)/);
    if (m) {
      if (cur.title || cur.body.some(l => l.trim())) sections.push(cur);
      cur = { title: m[1].trim(), body: [] };
    } else {
      cur.body.push(line);
    }
  }
  if (cur.title || cur.body.some(l => l.trim())) sections.push(cur);

  for (const sec of sections) {
    const card = document.createElement('div');
    if (!sec.title) {
      card.className = 'note-card sec-neutral';
      card.innerHTML = bodyToHtml(sec.body);
    } else {
      const meta = sectionMeta(sec.title);
      card.className = `note-card ${meta.cls}`;
      card.innerHTML =
        `<div class="note-head"><span class="note-dot"></span>${escapeHtml(sec.title)}</div>` +
        bodyToHtml(sec.body);
      if (meta.cls === 'sec-action' || meta.cls === 'sec-next') decorateAddButtons(card);
    }
    notesEl.appendChild(card);
  }
}

// add a "+ reminder" button to each list item in action-oriented sections
function decorateAddButtons(card) {
  for (const li of card.querySelectorAll('li')) {
    const text = li.textContent.trim();
    if (!text) continue;
    const btn = document.createElement('button');
    btn.className = 'li-add';
    btn.textContent = '+ reminder';
    btn.title = 'Add to action items';
    btn.addEventListener('click', async () => {
      if (await addReminderFromText(text, resultTitle.textContent)) {
        btn.textContent = '✓ added';
        btn.classList.add('added');
      }
    });
    li.appendChild(btn);
  }
}

// ---------- audio input devices ----------

async function listMics() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    // skip the synthetic 'default'/'communications' aliases; we expose our own "Default (OS)"
    return devices.filter(d => d.kind === 'audioinput'
      && d.deviceId !== 'default' && d.deviceId !== 'communications');
  } catch {
    return [];
  }
}

// labels are empty until mic permission is granted once
async function unlockMicLabels() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
  } catch { /* user may deny; we still show generic names */ }
}

async function populateMicSelect() {
  const mics = await listMics();
  const prev = micSelection;
  micSelect.innerHTML = '';
  micSelect.add(new Option('Default (OS)', 'default'));
  mics.forEach((d, i) => micSelect.add(new Option(d.label || `Microphone ${i + 1}`, d.deviceId)));
  if (mics.length > 1) micSelect.add(new Option('All microphones', 'all'));
  const exists = [...micSelect.options].some(o => o.value === prev);
  micSelect.value = exists ? prev : 'default';
  micSelection = micSelect.value;
}

function acquireMic(key) {
  const on = noiseReduction !== 'off';
  const audio = {
    echoCancellation: on,
    noiseSuppression: on,
    autoGainControl: noiseReduction === 'strong'
  };
  if (key !== 'default') audio.deviceId = { exact: key };
  return navigator.mediaDevices.getUserMedia({ audio });
}

// Web Audio post-filter on the mic bus (live-adjustable, no re-acquire needed)
function applyNoiseFilter() {
  if (!micHP || !micLP) return;
  if (noiseReduction === 'strong') {
    micHP.frequency.value = 130;
    micLP.frequency.value = 8000;
  } else if (noiseReduction === 'off') {
    micHP.frequency.value = 10;      // effectively bypass
    micLP.frequency.value = 20000;
  } else {
    micHP.frequency.value = 85;      // standard
    micLP.frequency.value = 20000;
  }
}

async function setNoiseReduction(level) {
  noiseReduction = level;
  localStorage.setItem('actas-noise', level);
  applyNoiseFilter();
  // the getUserMedia constraints differ per level, so re-acquire mics if recording
  if (audioCtx) {
    for (const key of [...micNodes.keys()]) dropMic(key);
    await applyMicSelection();
  }
}

function dropMic(key) {
  const node = micNodes.get(key);
  if (node) { try { node.disconnect(); } catch { /* already gone */ } }
  const stream = micStreams.get(key);
  if (stream) stream.getTracks().forEach(t => t.stop());
  micNodes.delete(key);
  micStreams.delete(key);
}

// Reconcile the live mic sources to match the current selection. Safe to call
// before recording (no-op) or mid-recording (hot-swaps on the live micBus).
async function applyMicSelection() {
  if (!audioCtx || !micBus) return;
  const mics = await listMics();
  let desired = micSelection === 'all' ? mics.map(d => d.deviceId) : [micSelection];
  if (desired.length === 0) desired = ['default'];

  for (const key of [...micNodes.keys()]) {
    if (!desired.includes(key)) dropMic(key);
  }
  for (const key of desired) {
    if (micNodes.has(key)) continue;
    try {
      const stream = await acquireMic(key);
      const node = audioCtx.createMediaStreamSource(stream);
      node.connect(micBus);
      micStreams.set(key, stream);
      micNodes.set(key, node);
    } catch { /* device busy/unavailable — skip it */ }
  }
}

micSelect.addEventListener('change', async () => {
  micSelection = micSelect.value;
  localStorage.setItem('actas-mic', micSelection);
  await applyMicSelection();
});

// ---------- volume sliders (live) ----------

const gainSysSlider = $('gain-sys');
const gainMicSlider = $('gain-mic');
const gainSysVal = $('gain-sys-val');
const gainMicVal = $('gain-mic-val');

function initGainSliders() {
  gainSysSlider.value = gainSys;
  gainMicSlider.value = gainMic;
  gainSysVal.textContent = gainSys.toFixed(1) + '×';
  gainMicVal.textContent = gainMic.toFixed(1) + '×';
}

gainSysSlider.addEventListener('input', () => {
  gainSys = parseFloat(gainSysSlider.value);
  gainSysVal.textContent = gainSys.toFixed(1) + '×';
  localStorage.setItem('actas-gain-sys', gainSys);
  if (sysGainNode) sysGainNode.gain.value = gainSys;
});

gainMicSlider.addEventListener('input', () => {
  gainMic = parseFloat(gainMicSlider.value);
  gainMicVal.textContent = gainMic.toFixed(1) + '×';
  localStorage.setItem('actas-gain-mic', gainMic);
  if (micBus) micBus.gain.value = gainMic;
});

initGainSliders();

// keep the list fresh and, while recording on "Default (OS)", follow the new default
navigator.mediaDevices.addEventListener('devicechange', async () => {
  await populateMicSelect();
  if (audioCtx) {
    if (micSelection === 'default') dropMic('default'); // re-acquire to follow OS default
    await applyMicSelection();
  }
});

// ---------- semi-live preview ----------

async function startLivePreview() {
  try {
    if (!(await window.actas.liveStart(options.participants))) return;
  } catch {
    return; // preview is best-effort; final transcript is unaffected
  }
  liveTranscriptEl.textContent = '';
  liveWrap.classList.remove('hidden');
  liveActive = true;
  cycleSegment();
}

function cycleSegment() {
  if (!liveActive || !dest) return;
  const segChunks = [];
  try {
    segRecorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
  } catch {
    return;
  }
  segRecorder.ondataavailable = e => { if (e.data.size) segChunks.push(e.data); };
  segRecorder.onstop = async () => {
    const blob = new Blob(segChunks, { type: 'audio/webm' });
    if (blob.size > 3000) {
      try { await window.actas.liveChunk(await blob.arrayBuffer()); } catch { /* worker gone */ }
    }
    if (liveActive && dest) cycleSegment();
  };
  segRecorder.start();
  segTimeout = setTimeout(() => {
    if (segRecorder && segRecorder.state !== 'inactive') segRecorder.stop();
  }, LIVE_SEGMENT_MS);
}

async function stopLivePreview() {
  liveActive = false;
  if (segTimeout) { clearTimeout(segTimeout); segTimeout = null; }
  if (segRecorder && segRecorder.state !== 'inactive') {
    try { segRecorder.stop(); } catch { /* already stopped */ }
  }
  segRecorder = null;
  liveWrap.classList.add('hidden');
  try { await window.actas.liveStop(); } catch { /* ignore */ }
}

window.actas.onLiveTranscript(line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.text) {
    liveTranscriptEl.textContent += (liveTranscriptEl.textContent ? ' ' : '') + msg.text;
    liveTranscriptEl.scrollTop = liveTranscriptEl.scrollHeight;
  }
});

// ---------- waveform visualizer ----------

function drawWave(m) {
  const { analyser, buf, ctx, canvas, color } = m;
  analyser.getByteTimeDomainData(buf);
  const w = canvas.width, h = canvas.height, mid = h / 2;
  ctx.clearRect(0, 0, w, h);

  // baseline
  ctx.strokeStyle = 'rgba(127,127,127,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();

  // waveform line
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.4;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const step = w / buf.length;
  let x = 0;
  for (let i = 0; i < buf.length; i++) {
    const y = mid + ((buf[i] - 128) / 128) * mid * 0.92;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    x += step;
  }
  ctx.stroke();
}

// ---------- recording ----------

async function startRecording() {
  chunks = [];
  try {
    // main.js answers this with Windows system-audio loopback (video must be requested even if unused)
    const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    sys.getVideoTracks().forEach(t => (t.enabled = false));
    sysStream = sys;

    audioCtx = new AudioContext();
    dest = audioCtx.createMediaStreamDestination();
    micBus = audioCtx.createGain();
    micBus.gain.value = gainMic;
    // mic noise-reduction filter chain: micBus -> highpass -> lowpass -> dest
    micHP = audioCtx.createBiquadFilter();
    micHP.type = 'highpass';
    micLP = audioCtx.createBiquadFilter();
    micLP.type = 'lowpass';
    micBus.connect(micHP);
    micHP.connect(micLP);
    micLP.connect(dest);
    applyNoiseFilter();

    const css = getComputedStyle(document.body);
    const colSys = css.getPropertyValue('--accent-2').trim() || '#54b8f2';
    const colMic = css.getPropertyValue('--accent').trim() || '#7c83ff';

    const makeViz = (sourceNode, canvas, color) => {
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      sourceNode.connect(analyser);
      return { analyser, canvas, ctx: canvas.getContext('2d'), color, buf: new Uint8Array(analyser.fftSize) };
    };

    analysers = { sys: null, mic: null };
    if (sys.getAudioTracks().length) {
      const sysSrc = audioCtx.createMediaStreamSource(sys);
      sysGainNode = audioCtx.createGain();
      sysGainNode.gain.value = gainSys;
      sysSrc.connect(sysGainNode);
      sysGainNode.connect(dest);
      analysers.sys = makeViz(sysGainNode, vizSys, colSys);
    }
    analysers.mic = makeViz(micBus, vizMic, colMic);

    await applyMicSelection();

    const updateLevels = () => {
      for (const m of [analysers.sys, analysers.mic]) {
        if (m) drawWave(m);
      }
      levelRaf = requestAnimationFrame(updateLevels);
    };
    updateLevels();

    recorder = new MediaRecorder(dest.stream, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 64000
    });
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.start(1000);
    startLivePreview();

    btnRecord.classList.add('hidden');
    recLive.classList.remove('hidden');
    pipelineEl.classList.add('hidden');
    statusEl.classList.add('hidden');
    if (micNodes.size === 0 && !sys.getAudioTracks().length) {
      setStatus(statusEl, 'Warning: no audio source could be captured.');
    } else if (!sys.getAudioTracks().length) {
      setStatus(statusEl, 'Warning: system audio could not be captured; only the mic is being recorded.');
    } else if (micNodes.size === 0) {
      setStatus(statusEl, 'Warning: no microphone could be captured; only system audio is being recorded.');
    }

    const t0 = Date.now();
    timerInterval = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      const p = n => String(n).padStart(2, '0');
      timerEl.textContent = s >= 3600
        ? `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`
        : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
    }, 500);
  } catch (err) {
    cleanupCapture();
    setStatus(statusEl, `Could not start recording: ${err.message}`, true);
  }
}

function cleanupCapture() {
  if (timerInterval) clearInterval(timerInterval);
  if (levelRaf) cancelAnimationFrame(levelRaf);
  timerInterval = null;
  levelRaf = null;
  for (const key of [...micNodes.keys()]) dropMic(key);
  if (sysStream) { sysStream.getTracks().forEach(t => t.stop()); sysStream = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  dest = null;
  micBus = null;
  sysGainNode = null;
  micHP = null;
  micLP = null;
  analysers = { sys: null, mic: null };
  recLive.classList.add('hidden');
  btnRecord.classList.remove('hidden');
  timerEl.textContent = '00:00';
}

async function stopAndProcess() {
  if (!recorder || recorder.state === 'inactive') return;
  await stopLivePreview();
  const stopped = new Promise(res => { recorder.onstop = res; });
  recorder.stop();
  await stopped;
  cleanupCapture();
  btnRecord.disabled = true;
  saveOptions();
  pipelineEl.classList.remove('hidden');
  resetPipeline();

  try {
    const blob = new Blob(chunks, { type: 'audio/webm' });
    chunks = [];
    if (blob.size < 5000) throw new Error('The recording is empty or too short.');

    setStep('save', 'active');
    const folder = await window.actas.saveRecording(await blob.arrayBuffer(), titleInput.value.trim(), options.participants);
    currentFolder = folder;
    setStep('save', 'done');

    setStep('transcribe', 'active');
    setStatus(statusEl, 'Transcribing locally with Whisper…\n');
    const transcript = await window.actas.transcribe(folder);
    setStep('transcribe', 'done');

    setStep('notes', 'active');
    setStatus(statusEl, 'Generating notes with Claude…');
    const summary = await window.actas.summarize(folder, transcript, options);
    setStep('notes', 'done');

    statusEl.classList.add('hidden');
    pipelineEl.classList.add('hidden');
    openMeetingView(titleInput.value.trim() || formatMeetingDate(folder.split(/[\\/]/).pop()), summary, transcript);
    titleInput.value = '';
    await refreshMeetingList();
  } catch (err) {
    pipelineEl.querySelectorAll('.step.active').forEach(s => { s.classList.remove('active'); s.classList.add('error'); });
    setStatus(statusEl, `Error: ${err.message}\nYour recording is safe — open the meeting in the sidebar and use "Transcribe now" to retry.`, true);
    refreshMeetingList();
  } finally {
    btnRecord.disabled = false;
  }
}

// ---------- meeting view ----------

function openMeetingView(title, summary, transcript, hasRecording = true, participants = null) {
  stopSpeak();
  exitEditMode();
  showView('meeting');
  regenStatusEl.classList.add('hidden');
  resultTitle.textContent = title;
  resultDateStr = currentFolder ? formatMeetingDate(currentFolder.split(/[\\/]/).pop()) : '';
  resultDate.textContent = resultDateStr;
  participantsMeet.value = participants != null ? participants : (options.participants || '');
  transcriptEl.textContent = transcript || '(no transcript)';
  btnRegen.disabled = !transcript;
  if (!transcript && hasRecording) {
    notesEl.innerHTML =
      '<div class="note-card sec-risk"><div class="note-head"><span class="note-dot"></span>Not transcribed</div>' +
      '<p>This meeting has a recording but no transcript yet (the transcription may have failed or been interrupted). Nothing is lost.</p>' +
      '<button id="btn-transcribe" class="inline-action">Transcribe now</button></div>';
    currentNotesMd = '';
    $('btn-transcribe').addEventListener('click', retryTranscribe);
  } else {
    renderNotes(summary);
  }
  // when there are no notes yet, show the transcript expanded
  document.querySelector('#view-meeting details').open = !(summary && summary.trim());
  syncOptionControls();
}

async function retryTranscribe() {
  const btn = $('btn-transcribe');
  if (btn) btn.disabled = true;
  setStatus(regenStatusEl, 'Transcribing with Whisper…\n');
  try {
    await window.actas.transcribe(currentFolder);
    const data = await window.actas.loadMeeting(currentFolder);
    regenStatusEl.classList.add('hidden');
    openMeetingView(resultTitle.textContent, data.summary, data.transcript, data.hasRecording, data.participants);
    await refreshMeetingList();
  } catch (err) {
    setStatus(regenStatusEl, `Error: ${err.message}`, true);
    if (btn) btn.disabled = false;
  }
}

function dateGroup(name) {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})_/);
  if (!m) return 'Earlier';
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'This week';
  if (diff < 30) return 'This month';
  return 'Earlier';
}

function renderMeetingList() {
  meetingList.innerHTML = '';
  const q = searchQuery.trim().toLowerCase();
  const items = allMeetings.filter(m =>
    !q || (m.title || '').toLowerCase().includes(q) || formatMeetingDate(m.name).toLowerCase().includes(q));

  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'm-empty';
    li.textContent = allMeetings.length === 0 ? 'No meetings yet.\nRecord or import to start.' : 'No matches';
    meetingList.appendChild(li);
    return;
  }

  let lastGroup = '';
  for (const m of items) {
    const g = dateGroup(m.name);
    if (g !== lastGroup) {
      lastGroup = g;
      const gh = document.createElement('li');
      gh.className = 'm-group';
      gh.textContent = g;
      meetingList.appendChild(gh);
    }
    const li = document.createElement('li');
    li.className = 'm-item' + (m.folder === currentFolder ? ' active' : '');

    const dot = document.createElement('span');
    dot.className = 'm-status ' + (m.hasSummary ? 'done' : (m.hasTranscript ? 'partial' : 'pending'));
    dot.title = m.hasSummary ? 'Notes ready' : (m.hasTranscript ? 'Transcript only' : 'Not transcribed');

    const body = document.createElement('div');
    body.className = 'm-body';
    const title = document.createElement('span');
    title.className = 'm-title';
    title.textContent = m.title || 'Meeting';
    const date = document.createElement('span');
    date.className = 'm-date';
    date.textContent = formatMeetingDate(m.name);
    body.append(title, date);

    li.append(dot, body);
    li.addEventListener('click', async () => {
      currentFolder = m.folder;
      const data = await window.actas.loadMeeting(m.folder);
      openMeetingView(data.title || formatMeetingDate(m.name), data.summary, data.transcript, data.hasRecording, data.participants);
      renderMeetingList();
    });
    meetingList.appendChild(li);
  }
}

async function refreshMeetingList() {
  allMeetings = await window.actas.listMeetings();
  renderMeetingList();
}

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  renderMeetingList();
});

// ---------- text-to-speech (read notes aloud) ----------

const synth = window.speechSynthesis;
let voices = [];
let speaking = false;

function loadVoices() {
  voices = synth.getVoices();
  if (!voices.length) return;
  const saved = localStorage.getItem('actas-voice') || '';
  const sorted = [...voices].sort((a, b) =>
    (b.lang.startsWith('en') - a.lang.startsWith('en')) || a.name.localeCompare(b.name));
  voiceSelect.innerHTML = '';
  for (const v of sorted) {
    const lang = v.lang.replace('_', '-');
    voiceSelect.add(new Option(`${v.name.replace(/Microsoft |Desktop/g, '').trim()} · ${lang}`, v.voiceURI));
  }
  if (saved && voices.some(v => v.voiceURI === saved)) {
    voiceSelect.value = saved;
  } else {
    const def = voices.find(v => v.lang.startsWith('en') && v.default)
      || voices.find(v => v.lang.startsWith('en')) || voices[0];
    if (def) voiceSelect.value = def.voiceURI;
  }
}

synth.addEventListener('voiceschanged', loadVoices);
loadVoices();

voiceSelect.addEventListener('change', () => localStorage.setItem('actas-voice', voiceSelect.value));

function updateSpeakBtn() {
  btnSpeak.classList.toggle('speaking', speaking);
  btnSpeak.querySelector('.speak-label').textContent = speaking ? 'Stop' : 'Read aloud';
}

function stopSpeak() {
  synth.cancel();
  speaking = false;
  updateSpeakBtn();
}

function chunkText(text) {
  const parts = text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]?/g) || [text];
  const chunks = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > 220) { if (cur) chunks.push(cur.trim()); cur = p; }
    else cur += p;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

btnSpeak.addEventListener('click', () => {
  if (speaking) { stopSpeak(); return; }
  const text = notesEl.innerText.trim();
  if (!text) return;
  const voice = voices.find(v => v.voiceURI === voiceSelect.value);
  const chunks = chunkText(text); // chunked to dodge the long-utterance cutoff bug
  speaking = true;
  updateSpeakBtn();
  chunks.forEach((c, i) => {
    const u = new SpeechSynthesisUtterance(c);
    if (voice) u.voice = voice;
    if (i === chunks.length - 1) u.onend = () => { speaking = false; updateSpeakBtn(); };
    u.onerror = () => { speaking = false; updateSpeakBtn(); };
    synth.speak(u);
  });
});

// ---------- events ----------

btnRecord.addEventListener('click', startRecording);
btnStop.addEventListener('click', stopAndProcess);

const btnImport = $('btn-import');
btnImport.addEventListener('click', async () => {
  btnImport.disabled = true;
  btnRecord.disabled = true;
  try {
    const picked = await window.actas.importAudio(options.participants);
    if (!picked) return;
    currentFolder = picked.folder;
    pipelineEl.classList.remove('hidden');
    resetPipeline();
    setStep('save', 'done');
    setStep('transcribe', 'active');
    setStatus(statusEl, 'Transcribing voice note verbatim with Whisper…\n');
    const transcript = await window.actas.transcribe(picked.folder);
    setStep('transcribe', 'done');
    statusEl.classList.add('hidden');
    pipelineEl.classList.add('hidden');
    openMeetingView(picked.title, '', transcript);
    await refreshMeetingList();
  } catch (err) {
    pipelineEl.querySelectorAll('.step.active').forEach(s => { s.classList.remove('active'); s.classList.add('error'); });
    setStatus(statusEl, `Error: ${err.message}`, true);
  } finally {
    btnImport.disabled = false;
    btnRecord.disabled = false;
  }
});

btnNew.addEventListener('click', () => {
  stopSpeak();
  currentFolder = null;
  showView('record');
  statusEl.classList.add('hidden');
  pipelineEl.classList.add('hidden');
  refreshMeetingList();
  titleInput.focus();
});

btnRegen.addEventListener('click', async () => {
  if (!currentFolder) return;
  btnRegen.disabled = true;
  // use the participants edited in this meeting's bar, and remember them as the default
  options.participants = participantsMeet.value;
  localStorage.setItem('actas-options', JSON.stringify(options));
  participantsRec.value = participantsMeet.value;
  setStatus(regenStatusEl, 'Regenerating notes with Claude…');
  try {
    const summary = await window.actas.regenerate(currentFolder, options);
    regenStatusEl.classList.add('hidden');
    renderNotes(summary);
    await refreshMeetingList();
  } catch (err) {
    setStatus(regenStatusEl, `Error: ${err.message}`, true);
  } finally {
    btnRegen.disabled = false;
  }
});

btnCopy.addEventListener('click', async () => {
  if (!currentNotesMd) return;
  await navigator.clipboard.writeText(currentNotesMd);
  btnCopy.textContent = 'Copied';
  setTimeout(() => { btnCopy.textContent = 'Copy'; }, 1500);
});

// ---------- edit notes by hand ----------

const notesEditor = $('notes-editor');
const notesTextarea = $('notes-textarea');
const btnEdit = $('btn-edit');

function enterEditMode() {
  stopSpeak();
  notesTextarea.value = currentNotesMd || '';
  notesEl.classList.add('hidden');
  notesEditor.classList.remove('hidden');
  btnEdit.classList.add('speaking'); // reuse accent style to show active state
  notesTextarea.focus();
}

function exitEditMode() {
  notesEditor.classList.add('hidden');
  notesEl.classList.remove('hidden');
  btnEdit.classList.remove('speaking');
}

btnEdit.addEventListener('click', () => {
  if (notesEditor.classList.contains('hidden')) enterEditMode();
  else exitEditMode();
});

$('btn-cancel-notes').addEventListener('click', exitEditMode);

$('btn-save-notes').addEventListener('click', async () => {
  if (!currentFolder) return;
  const md = notesTextarea.value.trim();
  const btn = $('btn-save-notes');
  btn.disabled = true;
  try {
    await window.actas.saveNotes(currentFolder, md);
    currentNotesMd = md;
    renderNotes(md);
    exitEditMode();
    await refreshMeetingList();
  } catch (err) {
    setStatus(regenStatusEl, `Could not save notes: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
});

const SECTION_PDF_COLORS = {
  'sec-summary': '#6356d6', 'sec-key': '#1d8cad', 'sec-decision': '#2c8f54',
  'sec-action': '#aa7012', 'sec-question': '#b94570', 'sec-risk': '#bb373d',
  'sec-next': '#1d8579', 'sec-neutral': '#7c8294'
};

function buildPdfHtml(title) {
  let body = '';
  for (const card of notesEl.querySelectorAll('.note-card')) {
    const cls = [...card.classList].find(c => c.startsWith('sec-')) || 'sec-neutral';
    const color = SECTION_PDF_COLORS[cls] || '#7c8294';
    const head = card.querySelector('.note-head');
    const headHtml = head
      ? `<div class="h" style="color:${color}">${escapeHtml(head.textContent.trim())}</div>`
      : '';
    // clone so we can strip interactive bits (the "+ reminder" buttons) without touching the UI
    const clone = card.cloneNode(true);
    clone.querySelectorAll('.li-add, button').forEach(el => el.remove());
    const headClone = clone.querySelector('.note-head');
    if (headClone) headClone.remove();
    body += `<div class="card" style="border-color:${color}">${headHtml}${clone.innerHTML}</div>`;
  }
  const css = `
    * { box-sizing: border-box; }
    body { font-family: "Segoe UI", system-ui, sans-serif; color: #1c1f27; margin: 0; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .date { color: #646b7d; font-size: 12px; margin-bottom: 18px; }
    .card { border-left: 4px solid #999; background: #fafbfc; border-radius: 6px;
            padding: 12px 16px; margin-bottom: 12px; page-break-inside: avoid; }
    .h { font-size: 12px; font-weight: 700; letter-spacing: 0.7px; text-transform: uppercase; margin-bottom: 6px; }
    ul { padding-left: 20px; margin: 4px 0; } li { margin-bottom: 4px; line-height: 1.5; }
    p { margin: 4px 0; line-height: 1.55; } strong { color: #000; }
    h3 { font-size: 13px; margin: 8px 0 4px; }
    .foot { margin-top: 22px; color: #9aa0b0; font-size: 10px; border-top: 1px solid #e3e6ec; padding-top: 8px; }`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head>` +
    `<body><h1>${escapeHtml(title)}</h1><div class="date">${escapeHtml(resultDateStr)}</div>` +
    `${body}<div class="foot">Generated with Actas</div></body></html>`;
}

const btnPdf = $('btn-pdf');
btnPdf.addEventListener('click', async () => {
  if (!currentNotesMd) return;
  btnPdf.disabled = true;
  try {
    const saved = await window.actas.exportPdf(buildPdfHtml(resultTitle.textContent), resultTitle.textContent);
    if (saved) {
      btnPdf.textContent = 'Saved';
      setTimeout(() => { btnPdf.textContent = 'Export PDF'; }, 1500);
    }
  } catch (err) {
    setStatus(regenStatusEl, `PDF export failed: ${err.message}`, true);
  } finally {
    btnPdf.disabled = false;
  }
});

btnOpenFolder.addEventListener('click', () => {
  if (currentFolder) window.actas.openFolder(currentFolder);
});

window.actas.onTranscribeProgress(text => {
  for (const el of [statusEl, regenStatusEl]) {
    if (!el.classList.contains('hidden')) {
      el.textContent += text;
      el.scrollTop = el.scrollHeight;
    }
  }
});

// ---------- reminders / action items ----------

const btnReminders = $('btn-reminders');
const remindersCount = $('reminders-count');
const remindersList = $('reminders-list');
const newReminderInput = $('new-reminder');

function updateReminderCount(list) {
  const pending = list.filter(r => !r.done).length;
  remindersCount.textContent = pending;
  remindersCount.classList.toggle('hidden', pending === 0);
}

function renderReminders(list) {
  remindersList.innerHTML = '';
  if (list.length === 0) {
    const li = document.createElement('li');
    li.className = 'reminders-empty';
    li.textContent = 'No action items yet. Add one above, or use the + on action items inside a meeting.';
    remindersList.appendChild(li);
    return;
  }
  const sorted = [...list].sort((a, b) => (a.done - b.done) || (b.createdAt - a.createdAt));
  for (const r of sorted) {
    const li = document.createElement('li');
    li.className = 'reminder' + (r.done ? ' done' : '');

    const check = document.createElement('button');
    check.className = 'r-check';
    check.title = r.done ? 'Mark as not done' : 'Mark as done';
    check.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M3 8.5l3 3 7-7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    check.addEventListener('click', async () => {
      await window.actas.updateReminder(r.id, { done: !r.done });
      await refreshReminders();
    });

    const main = document.createElement('div');
    main.className = 'r-main';
    const text = document.createElement('input');
    text.className = 'r-text';
    text.value = r.text;
    text.addEventListener('change', () => window.actas.updateReminder(r.id, { text: text.value.trim() }));
    text.addEventListener('keydown', e => { if (e.key === 'Enter') text.blur(); });
    main.appendChild(text);
    if (r.source) {
      const src = document.createElement('span');
      src.className = 'r-source';
      src.textContent = 'from: ' + r.source;
      main.appendChild(src);
    }

    const del = document.createElement('button');
    del.className = 'r-del';
    del.title = 'Delete';
    del.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    del.addEventListener('click', async () => {
      await window.actas.deleteReminder(r.id);
      await refreshReminders();
    });

    li.append(check, main, del);
    remindersList.appendChild(li);
  }
}

async function refreshReminders() {
  const list = await window.actas.listReminders();
  updateReminderCount(list);
  if (!viewReminders.classList.contains('hidden')) renderReminders(list);
}

async function addReminderFromText(text, source) {
  const t = (text || '').trim();
  if (!t) return false;
  await window.actas.addReminder(t, source || '');
  await refreshReminders();
  return true;
}

btnReminders.addEventListener('click', async () => {
  stopSpeak();
  showView('reminders');
  const list = await window.actas.listReminders();
  updateReminderCount(list);
  renderReminders(list);
});

function submitNewReminder() {
  const t = newReminderInput.value.trim();
  if (!t) return;
  newReminderInput.value = '';
  addReminderFromText(t, '');
}
$('btn-add-reminder').addEventListener('click', submitNewReminder);
newReminderInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitNewReminder(); });

// ---------- init ----------

syncOptionControls();
showView('record');
refreshMeetingList();
refreshReminders();

(async () => {
  await unlockMicLabels();
  await populateMicSelect();
})();

(async () => {
  try {
    const env = await window.actas.checkEnvironment();
    const issues = [];
    if (!env.whisper) issues.push('• Python with faster-whisper was not found — transcription will not work. Run setup.ps1 from the app folder.');
    if (!env.claude) issues.push('• Claude Code CLI was not found — note generation will not work. Install it from claude.com/code and sign in.');
    if (issues.length) setStatus(statusEl, 'Setup needed:\n' + issues.join('\n'), true);
  } catch { /* never block the app on the preflight check */ }
})();
