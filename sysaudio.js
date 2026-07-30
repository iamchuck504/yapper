// System audio on macOS: the other side of the call.
//
// Windows gets it from Electron's loopback, mixed in the renderer's audio graph
// alongside the microphone. macOS has no loopback, so it comes from a native
// helper (mac/system-audio.swift) as 16 kHz mono PCM on stdout, and the mixing
// happens here instead — same samples, same rate, one addition per sample.
//
// The microphone sets the pace. Every chunk the renderer sends asks this module
// for the same number of bytes of system audio, so the mix cannot drift from
// what is being written to the file: if the helper is behind, the gap is
// silence, and if it is ahead, the surplus waits its turn.

const { spawn } = require('child_process');
const fs = require('fs');

// Two clocks are never exactly equal, so the buffer would creep up over a long
// meeting and the system side would lag further and further behind the voice.
// Half a second is more slack than the helper's delivery ever needs; past that,
// the oldest audio is the part worth dropping.
const MAX_BUFFERED = 16000 * 2 / 2;   // 0.5 s of 16 kHz mono 16-bit

/** Add two PCM16 buffers, saturating instead of wrapping. */
function mixPcm(a, b) {
  const n = Math.min(a.length, b.length) & ~1;     // whole samples only
  const out = Buffer.from(a);
  for (let i = 0; i < n; i += 2) {
    // Wrapping would turn a loud moment into a burst of noise, which is worse
    // than the clipping it would be hiding.
    const sum = out.readInt16LE(i) + b.readInt16LE(i);
    out.writeInt16LE(sum > 32767 ? 32767 : sum < -32768 ? -32768 : sum, i);
  }
  return out;
}

function create({ probePath, onStatus = () => { } } = {}) {
  let proc = null;
  let chunks = [];
  let buffered = 0;
  let dropped = 0;
  let state = 'off';        // off | starting | capturing | unavailable
  let stopping = false;     // an expected exit: stop() asked for it
  let restarts = 0;         // one silent retry per recording, no more

  const push = data => {
    chunks.push(data);
    buffered += data.length;
    while (buffered > MAX_BUFFERED && chunks.length > 1) {
      const gone = chunks.shift();
      buffered -= gone.length;
      dropped += gone.length;
    }
  };

  const api = {
    get state() { return state; },
    get buffered() { return buffered; },
    get droppedBytes() { return dropped; },

    /**
     * Start capturing. Resolves to true when the helper is running, false when
     * system audio is not available — a missing Screen Recording permission,
     * or no helper on disk. False is not an error: the microphone alone still
     * records, which is what this platform did before any of this existed.
     */
    start() {
      return new Promise(resolve => {
        if (proc) return resolve(state === 'capturing');
        if (!probePath || !fs.existsSync(probePath)) {
          state = 'unavailable';
          onStatus({ ok: false, reason: 'no-helper' });
          return resolve(false);
        }
        state = 'starting';
        stopping = false;
        chunks = []; buffered = 0; dropped = 0;

        try {
          proc = spawn(probePath, []);
        } catch (err) {
          state = 'unavailable';
          onStatus({ ok: false, reason: 'spawn-failed', detail: err.message });
          return resolve(false);
        }

        let settled = false;
        const settle = ok => { if (!settled) { settled = true; resolve(ok); } };

        proc.stdout.on('data', push);
        // The helper says "capturing" on stderr once the stream is live, and
        // exits with 2 when the permission is the thing standing in the way.
        proc.stderr.on('data', d => {
          const text = d.toString();
          if (/capturing/.test(text)) {
            state = 'capturing';
            onStatus({ ok: true });
            settle(true);
          } else if (text.trim()) {
            onStatus({ ok: false, reason: 'helper', detail: text.trim().slice(0, 200) });
          }
        });
        proc.on('error', err => {
          state = 'unavailable';
          onStatus({ ok: false, reason: 'spawn-failed', detail: err.message });
          settle(false);
        });
        proc.on('close', code => {
          proc = null;
          const wasCapturing = state === 'capturing';
          if (state !== 'off') {
            state = code === 2 ? 'unavailable' : (wasCapturing ? 'off' : 'unavailable');
            if (code === 2) onStatus({ ok: false, reason: 'permission' });
          }
          settle(false);

          // Dying mid-recording is the dangerous case: take() starts returning
          // null, the microphone alone carries on, and the recording quietly
          // becomes half a conversation. One silent retry covers a transient
          // fault — the far side loses a second, not the rest of the meeting —
          // and if it will not come back, say so rather than let the user find
          // out afterwards.
          if (wasCapturing && !stopping) {
            if (restarts < 1) {
              restarts++;
              api.start().then(ok => {
                if (!ok) onStatus({ ok: false, reason: 'stopped' });
              });
            } else {
              onStatus({ ok: false, reason: 'stopped' });
            }
          }
        });

        // Never hang the start of a recording on a helper that says nothing.
        setTimeout(() => {
          if (!settled) onStatus({ ok: false, reason: 'timeout' });
          settle(state === 'capturing');
        }, 4000);
      });
    },

    /**
     * The next `bytes` of system audio, padded with silence when the helper has
     * not produced enough yet. Returns null when nothing is being captured, so
     * the caller can write the microphone through untouched.
     */
    take(bytes) {
      if (state !== 'capturing') return null;
      const out = Buffer.alloc(bytes);          // silence is the default
      let filled = 0;
      while (filled < bytes && chunks.length) {
        const head = chunks[0];
        const need = bytes - filled;
        if (head.length <= need) {
          head.copy(out, filled);
          filled += head.length;
          buffered -= head.length;
          chunks.shift();
        } else {
          head.copy(out, filled, 0, need);
          chunks[0] = head.subarray(need);
          buffered -= need;
          filled += need;
        }
      }
      return out;
    },

    stop() {
      stopping = true;      // so the exit is not mistaken for a crash
      state = 'off';
      // The retry budget is per recording, and it is spent here rather than in
      // start(), which the retry itself calls — resetting there would buy an
      // unlimited supply of retries from a helper that crashes on a loop.
      restarts = 0;
      chunks = []; buffered = 0;
      if (proc) {
        try { proc.kill(); } catch { /* already gone */ }
        proc = null;
      }
    }
  };

  return api;
}

module.exports = { create, mixPcm, MAX_BUFFERED };
