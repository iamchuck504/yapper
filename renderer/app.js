const $ = id => document.getElementById(id);

const viewRecord = $('view-record');
const viewMeeting = $('view-meeting');
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
const meterSys = $('meter-sys');
const meterMic = $('meter-mic');
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
let streams = [];
let audioCtx = null;
let timerInterval = null;
let levelRaf = null;
let currentFolder = null;
let currentNotesMd = '';
let resultDateStr = '';

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

const options = Object.assign(
  { style: 'general', detail: 'concise', custom: '' },
  JSON.parse(localStorage.getItem('actas-options') || '{}')
);

function saveOptions() {
  options.custom = customInput.value;
  localStorage.setItem('actas-options', JSON.stringify(options));
}

function syncOptionControls() {
  document.querySelectorAll('#style-pills .seg-btn').forEach(p =>
    p.classList.toggle('active', p.dataset.style === options.style));
  document.querySelectorAll('#detail-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.detail === options.detail));
  customInput.value = options.custom || '';
  regenStyle.value = options.style;
  regenDetail.value = options.detail;
}

document.querySelectorAll('#style-pills .seg-btn').forEach(p =>
  p.addEventListener('click', () => { options.style = p.dataset.style; saveOptions(); syncOptionControls(); }));
document.querySelectorAll('#detail-seg .seg-btn').forEach(b =>
  b.addEventListener('click', () => { options.detail = b.dataset.detail; saveOptions(); syncOptionControls(); }));
customInput.addEventListener('change', saveOptions);
regenStyle.addEventListener('change', () => { options.style = regenStyle.value; saveOptions(); syncOptionControls(); });
regenDetail.addEventListener('change', () => { options.detail = regenDetail.value; saveOptions(); syncOptionControls(); });

// ---------- helpers ----------

function showView(name) {
  viewRecord.classList.toggle('hidden', name !== 'record');
  viewMeeting.classList.toggle('hidden', name !== 'meeting');
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
  { match: /summary/i, cls: 'sec-summary' },
  { match: /key point|topic/i, cls: 'sec-key' },
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
    }
    notesEl.appendChild(card);
  }
}

// ---------- recording ----------

async function startRecording() {
  chunks = [];
  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    });
    // main.js answers this with Windows system-audio loopback (video must be requested even if unused)
    const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    sys.getVideoTracks().forEach(t => (t.enabled = false));
    streams = [mic, sys];

    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    const meters = [];
    for (const [stream, meter] of [[mic, meterMic], [sys, meterSys]]) {
      if (stream.getAudioTracks().length === 0) continue;
      const src = audioCtx.createMediaStreamSource(stream);
      src.connect(dest);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      meters.push({ analyser, meter, buf: new Uint8Array(analyser.frequencyBinCount) });
    }

    const updateLevels = () => {
      for (const m of meters) {
        m.analyser.getByteTimeDomainData(m.buf);
        let peak = 0;
        for (const v of m.buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
        m.meter.value = peak;
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

    btnRecord.classList.add('hidden');
    recLive.classList.remove('hidden');
    pipelineEl.classList.add('hidden');
    statusEl.classList.add('hidden');
    if (sys.getAudioTracks().length === 0) {
      setStatus(statusEl, 'Warning: system audio could not be captured; only the mic is being recorded.');
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
  streams.forEach(s => s.getTracks().forEach(t => t.stop()));
  streams = [];
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  recLive.classList.add('hidden');
  btnRecord.classList.remove('hidden');
  timerEl.textContent = '00:00';
}

async function stopAndProcess() {
  if (!recorder || recorder.state === 'inactive') return;
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
    const folder = await window.actas.saveRecording(await blob.arrayBuffer(), titleInput.value.trim());
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

function openMeetingView(title, summary, transcript, hasRecording = true) {
  showView('meeting');
  regenStatusEl.classList.add('hidden');
  resultTitle.textContent = title;
  resultDateStr = currentFolder ? formatMeetingDate(currentFolder.split(/[\\/]/).pop()) : '';
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
    openMeetingView(resultTitle.textContent, data.summary, data.transcript, data.hasRecording);
    await refreshMeetingList();
  } catch (err) {
    setStatus(regenStatusEl, `Error: ${err.message}`, true);
    if (btn) btn.disabled = false;
  }
}

async function refreshMeetingList() {
  const meetings = await window.actas.listMeetings();
  meetingList.innerHTML = '';
  for (const m of meetings) {
    const li = document.createElement('li');
    if (m.folder === currentFolder) li.classList.add('active');
    const title = document.createElement('span');
    title.className = 'm-title' + (m.hasSummary ? '' : ' m-pending');
    title.textContent = m.title || 'Meeting';
    const date = document.createElement('span');
    date.className = 'm-date';
    date.textContent = formatMeetingDate(m.name) + (m.hasTranscript ? '' : ' · not transcribed');
    li.append(title, date);
    li.addEventListener('click', async () => {
      currentFolder = m.folder;
      const data = await window.actas.loadMeeting(m.folder);
      openMeetingView(data.title || formatMeetingDate(m.name), data.summary, data.transcript, data.hasRecording);
      refreshMeetingList();
    });
    meetingList.appendChild(li);
  }
}

// ---------- events ----------

btnRecord.addEventListener('click', startRecording);
btnStop.addEventListener('click', stopAndProcess);

const btnImport = $('btn-import');
btnImport.addEventListener('click', async () => {
  btnImport.disabled = true;
  btnRecord.disabled = true;
  try {
    const picked = await window.actas.importAudio();
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
    const inner = card.innerHTML.replace(/<div class="note-head">[\s\S]*?<\/div>/, '');
    body += `<div class="card" style="border-color:${color}">${headHtml}${inner}</div>`;
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

// ---------- init ----------

syncOptionControls();
showView('record');
refreshMeetingList();

(async () => {
  try {
    const env = await window.actas.checkEnvironment();
    const issues = [];
    if (!env.whisper) issues.push('• Python with faster-whisper was not found — transcription will not work. Run setup.ps1 from the app folder.');
    if (!env.claude) issues.push('• Claude Code CLI was not found — note generation will not work. Install it from claude.com/code and sign in.');
    if (issues.length) setStatus(statusEl, 'Setup needed:\n' + issues.join('\n'), true);
  } catch { /* never block the app on the preflight check */ }
})();
