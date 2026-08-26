'use strict';

// Speaker diarization is deliberately isolated from transcription. Whisper
// decides what was said; the native helper decides only who was speaking on
// the already-separated remote/system track. If the helper or its local
// models are unavailable, every function here falls back to the old Them:
// label and the meeting still finishes normally.

const fs = require('fs');
const { spawn } = require('child_process');

const MAX_HELPER_OUTPUT = 16 * 1024 * 1024;
const MAX_SEGMENTS = 500000;
const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;
const MAX_LINE_MATCH_DISTANCE_SECONDS = 10;
const SPEAKER_LABEL = /^(Me|Them|Speaker [1-9]\d*)$/;

function stampSeconds(line) {
  const m = String(line || '').match(/^\[(?:(\d+):)?(\d{2}):(\d{2})\]/);
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function cleanSegments(value) {
  const list = Array.isArray(value) ? value : value && value.segments;
  if (!Array.isArray(list) || list.length > MAX_SEGMENTS) return [];
  return list.map(item => ({
    speaker: String(item && (item.speaker || item.speakerId) || '').slice(0, 100),
    start: Number(item && (item.start ?? item.startTimeSeconds)),
    end: Number(item && (item.end ?? item.endTimeSeconds))
  })).filter(item => item.speaker && Number.isFinite(item.start)
    && Number.isFinite(item.end) && item.start >= 0 && item.end > item.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function parseHelperOutput(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_HELPER_OUTPUT) return [];
  try { return cleanSegments(JSON.parse(text)); } catch { return []; }
}

/** Run the local Core ML helper. Failure is data, not an exception: callers
 * must always be able to complete the transcript without diarization. */
function diarizeFile(helper, audioFile, options = {}) {
  if (process.platform !== 'darwin' || !helper || !audioFile
      || !fs.existsSync(helper) || !fs.existsSync(audioFile)) {
    const none = Promise.resolve({ segments: [], available: false, reason: 'unavailable' });
    none.cancel = () => { };
    return none;
  }

  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  // The promise carries a `cancel()`: the caller may learn, once the far side
  // is transcribed, that there is nothing to label — and the helper should
  // stop chewing the file then rather than finish for nobody.
  let cancel = () => { };
  const promise = new Promise(resolve => {
    let proc;
    let stdout = Buffer.alloc(0);
    let stderr = '';
    let settled = false;
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    try {
      proc = spawn(helper, [audioFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return finish({ segments: [], available: false, reason: err.message });
    }
    cancel = () => {
      if (settled) return;
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      finish({ segments: [], available: true, reason: 'not needed' });
    };

    proc.stdout.on('data', chunk => {
      if (stdout.length + chunk.length > MAX_HELPER_OUTPUT) {
        try { proc.kill('SIGTERM'); } catch { /* already gone */ }
        return finish({ segments: [], available: true, reason: 'helper output was too large' });
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    proc.stderr.on('data', chunk => {
      stderr = (stderr + String(chunk)).slice(-32768);
      const matches = [...stderr.matchAll(/YAPPER_DIARIZE_PROGRESS\s+(\d+)\/(\d+)/g)];
      if (matches.length && typeof options.onProgress === 'function') {
        const last = matches[matches.length - 1];
        options.onProgress(Number(last[1]), Number(last[2]));
      }
    });
    proc.on('error', err => finish({ segments: [], available: false, reason: err.message }));
    proc.on('close', code => {
      const segments = code === 0 ? parseHelperOutput(stdout.toString('utf8')) : [];
      finish({
        segments,
        available: true,
        reason: segments.length ? '' : (stderr.trim().split(/\r?\n/).pop() || `helper exited ${code}`)
      });
    });
    timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }, 1500).unref();
      finish({ segments: [], available: true, reason: 'speaker detection timed out' });
    }, timeoutMs);
    timer.unref();
  });
  promise.cancel = () => cancel();
  return promise;
}

function displaySegments(segments) {
  const normalized = cleanSegments(segments);
  const ids = new Map();
  for (const segment of normalized) {
    if (!ids.has(segment.speaker)) ids.set(segment.speaker, `Speaker ${ids.size + 1}`);
  }
  return normalized.map(segment => ({ ...segment, speaker: ids.get(segment.speaker) }));
}

function overlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function nearestDistance(at, segment) {
  if (at < segment.start) return segment.start - at;
  if (at > segment.end) return at - segment.end;
  return 0;
}

/** Attach one stable label to every remote Whisper line. Whisper currently
 * yields segment-level timestamps, so the best label is the voice with the
 * greatest overlap until the next transcript segment. */
function labelRemoteLines(lines, rawSegments) {
  const segments = displaySegments(rawSegments);
  if (!segments.length) return { lines: [...lines], segments: [], speakers: [] };

  const stamped = lines.map((line, index) => ({ line, index, at: stampSeconds(line) }));
  const labelled = stamped.map((entry, index) => {
    if (entry.at == null) return entry.line;
    let end = entry.at + 6;
    for (let next = index + 1; next < stamped.length; next++) {
      if (stamped[next].at != null && stamped[next].at > entry.at) {
        end = stamped[next].at;
        break;
      }
    }
    // A very long Whisper segment should not absorb several later turns.
    end = Math.min(end, entry.at + 15);
    const scores = new Map();
    for (const segment of segments) {
      const score = overlap(entry.at, end, segment.start, segment.end);
      if (score > 0) scores.set(segment.speaker, (scores.get(segment.speaker) || 0) + score);
    }
    let speaker = [...scores].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!speaker) {
      const nearest = segments.map(segment => ({
        speaker: segment.speaker,
        distance: nearestDistance(entry.at, segment)
      })).sort((a, b) => a.distance - b.distance)[0];
      // Whisper timestamps can trail the acoustic segment by several seconds,
      // especially when it breaks one utterance into multiple text lines. The
      // line still came from this remote-only track, so prefer the nearby voice
      // over falling back to the vague `Them` label.
      if (nearest && nearest.distance <= MAX_LINE_MATCH_DISTANCE_SECONDS) speaker = nearest.speaker;
    }
    if (!speaker) return entry.line;
    const m = entry.line.match(/^(\[[\d:]+\])\s*(.*)$/);
    return m ? `${m[1]} ${speaker}: ${m[2]}` : `${speaker}: ${entry.line}`;
  });

  return {
    lines: labelled,
    segments,
    speakers: [...new Set(segments.map(segment => segment.speaker))]
  };
}

function sanitizeName(value) {
  return String(value == null ? '' : value)
    .replace(/[\r\n:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function normalizeSpeakerMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [label, valueName] of Object.entries(value)) {
    if (!SPEAKER_LABEL.test(label)) continue;
    const name = sanitizeName(valueName);
    if (name && name !== label) out[label] = name;
  }
  return out;
}

function applySpeakerMap(rawTranscript, value) {
  const map = normalizeSpeakerMap(value);
  return String(rawTranscript || '').split(/\r?\n/).map(line => line.replace(
    /^(\[[\d:]+\]\s+)?(Me|Them|Speaker [1-9]\d*):\s*/,
    (whole, stamp = '', label) => `${stamp}${map[label] || label}: `
  )).join('\n');
}

function transcriptSpeakerLabels(rawTranscript) {
  const found = new Set();
  for (const line of String(rawTranscript || '').split(/\r?\n/)) {
    const m = line.match(/^(?:\[[\d:]+\]\s+)?(Me|Them|Speaker [1-9]\d*):\s*/);
    if (m) found.add(m[1]);
  }
  return [...found].sort((a, b) => {
    if (a === 'Me') return -1;
    if (b === 'Me') return 1;
    if (a === 'Them') return 1;
    if (b === 'Them') return -1;
    return Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''));
  });
}

function speakerState(rawTranscript, value) {
  const map = normalizeSpeakerMap(value);
  return transcriptSpeakerLabels(rawTranscript).map(label => ({ label, name: map[label] || '' }));
}

/**
 * Numbered voices are useful evidence in the transcript, but poor prose in
 * meeting notes. Keep the distinction without exposing the implementation:
 * "Speaker 1 disagreed with Speaker 2" becomes "one participant disagreed
 * with another participant" (or the Spanish equivalent). The prompt asks the
 * model to do this naturally; this is the deterministic last line of defence.
 */
function generalizeNoteSpeakers(value, language = 'en') {
  const text = String(value || '');
  if (!/\bSpeaker [1-9]\d*\b/.test(text)) return text;

  let spanish = language === 'es';
  if (language === 'auto') {
    const lower = text.toLowerCase();
    const es = (lower.match(/\b(?:el|la|los|las|una|uno|que|para|con|por|del|se|fue|como|pero|también)\b/g) || []).length;
    const en = (lower.match(/\b(?:the|a|an|that|for|with|from|was|were|as|but|also|will)\b/g) || []).length;
    spanish = es > en;
  }

  const first = spanish ? 'una persona' : 'one participant';
  const other = spanish ? 'otra persona' : 'another participant';
  return text.split(/\r?\n/).map(line => {
    const names = new Map();
    return line.replace(/\bSpeaker [1-9]\d*\b/g, (label, offset) => {
      if (!names.has(label)) names.set(label, names.size ? other : first);
      let replacement = names.get(label);
      const before = line.slice(0, offset);
      if (/^\s*(?:(?:[-*+] |\d+[.)] )?)$/.test(before)) {
        replacement = replacement[0].toUpperCase() + replacement.slice(1);
      }
      return replacement;
    });
  }).join('\n');
}

module.exports = {
  stampSeconds,
  cleanSegments,
  parseHelperOutput,
  diarizeFile,
  displaySegments,
  labelRemoteLines,
  sanitizeName,
  normalizeSpeakerMap,
  applySpeakerMap,
  transcriptSpeakerLabels,
  speakerState,
  generalizeNoteSpeakers
};
