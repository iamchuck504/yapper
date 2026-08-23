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

/**
 * Kill helpers left behind by a run that died.
 *
 * The helper holds a system-wide audio tap for as long as it lives, and it
 * outlives a parent that is *killed* rather than closed — a crash, a force
 * quit, a debugger stopped mid-recording. What is left is a process still
 * capturing everything the machine plays, with no window and no way for anyone
 * to notice, and it takes the microphone with it: three of them, orphaned by an
 * afternoon of testing, were enough to make the next recording hang waiting for
 * a device that was never coming free.
 *
 * Once per run, before the first helper starts, for the same reason engine.js
 * reaps whisper-servers once: orphans belong to *previous* executions, and a
 * second sweep would kill the helper this run just spawned.
 */
let reaped = false;
function reapOrphans(probePath) {
  if (reaped || !probePath) return 0;
  reaped = true;
  try {
    const found = require('child_process').spawnSync('pgrep', ['-f', probePath], { encoding: 'utf8' });
    const pids = String(found.stdout || '').split('\n')
      .map(s => Number(s.trim())).filter(pid => pid && pid !== process.pid);
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    return pids.length;
  } catch {
    return 0;                 // best effort: never block a recording over this
  }
}

function create({ probePath, onStatus = () => { } } = {}) {
  let proc = null;
  let chunks = [];
  let buffered = 0;
  let dropped = 0;
  let state = 'off';        // off | starting | capturing | unavailable
  let stopping = false;     // an expected exit: stop() asked for it
  let restarts = 0;         // one silent retry per recording, no more
  let startTimer = null;    // the 4 s "say something" deadline of the current launch

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

        const orphans = reapOrphans(probePath);
        if (orphans) console.log(`[audio] cleaned up ${orphans} helper(s) from a previous run`);

        try {
          proc = spawn(probePath, []);
        } catch (err) {
          state = 'unavailable';
          onStatus({ ok: false, reason: 'spawn-failed', detail: err.message });
          return resolve(false);
        }
        // Everything below belongs to this launch and only this one. A helper
        // stopped and restarted quickly — two recordings back to back — has
        // its close, its stderr and its deadline still in flight while the
        // next one is starting; acting on them would null the new process,
        // read the new one's "capturing" as the old one's, or release the
        // display hold the new one just took.
        const child = proc;
        const mine = () => proc === child;
        // 'audio' or 'screen', named by the helper before it exits with 2 —
        // the two doors do not lead to the same Settings pane. Per launch: a
        // refusal from the last one says nothing about this one.
        let missingPermission = null;

        let settled = false;
        const settle = ok => { if (!settled) { settled = true; resolve(ok); } };

        proc.stdout.on('data', d => { if (mine()) push(d); });
        // The helper says "capturing" on stderr once the stream is live, and
        // exits with 2 when the permission is the thing standing in the way.
        // Which permission depends on the door it took — a process tap wants
        // "System Audio Recording Only", ScreenCaptureKit wants Screen
        // Recording — and it names it before exiting so the app can point at
        // the pane that actually holds the switch.
        // One line at a time. A chunk can carry several lines at once — a
        // "note:" followed by "capturing: screen" when the main process was
        // busy — and judging the chunk by its first line lost the second.
        let errBuf = '';
        let namedFailure = false;   // the helper said what went wrong, in its own words
        // One reading of one line, used for the lines that arrive and again
        // for whatever was left unterminated when the helper exited.
        const classify = line => {
          if (!line) return;
          // Advisory lines are for the log only.
          if (/^note:/.test(line)) {
            console.log('[audio] helper:', line.replace(/^note:\s*/, '').slice(0, 300));
            return;
          }
          // Still capturing, but the helper doubts what it is capturing.
          const doubt = /^suspect:\s*(audio|screen)\s*$/.exec(line);
          if (doubt) { onStatus({ ok: false, reason: 'suspect', which: doubt[1] }); return; }
          const which = /^permission:\s*(audio|screen)/.exec(line);
          if (which) { missingPermission = which[1]; namedFailure = true; return; }
          if (missingPermission) return;      // the lines after it explain it
          // The protocol line, whole: an error that merely contains the word
          // ("could not start capture: failed while capturing") is not it.
          const live = /^capturing:\s*(tap|screen)\s*$/.exec(line);
          if (live) {
            state = 'capturing';
            // Which door it came through decides whether the display has to
            // be held awake: a tap does not care, ScreenCaptureKit cannot
            // capture without a display at all.
            onStatus({ ok: true, via: live[1] });
            settle(true);
            return;
          }
          namedFailure = true;
          onStatus({ ok: false, reason: 'helper', detail: line.slice(0, 200) });
        };
        proc.stderr.on('data', d => {
          if (!mine() || stopping) return;   // a late line after stop() means nothing
          errBuf += d.toString();
          let nl;
          while ((nl = errBuf.indexOf('\n')) >= 0) {
            const line = errBuf.slice(0, nl).trim();
            errBuf = errBuf.slice(nl + 1);
            classify(line);
          }
        });
        proc.on('error', err => {
          if (!mine()) return;
          // `close` follows `error` for spawn failures. Count this as the
          // named reason so that close does not emit a second helper-exit for
          // the same launch and overwrite the more useful spawn detail.
          namedFailure = true;
          state = 'unavailable';
          onStatus({ ok: false, reason: 'spawn-failed', detail: err.message });
          settle(false);
        });
        proc.on('close', code => {
          if (!mine()) return;          // stop() already let go of it, or a newer launch owns the state
          if (startTimer) { clearTimeout(startTimer); startTimer = null; }
          proc = null;
          // A last line with no newline on it still says something — and it
          // is read the same way as any other, so a truncated "permission:
          // audio" still names its pane instead of becoming loose text.
          const tail = errBuf.trim();
          errBuf = '';
          if (tail) classify(tail);
          const wasCapturing = state === 'capturing';
          if (state !== 'off') {
            state = code === 2 ? 'unavailable' : (wasCapturing ? 'off' : 'unavailable');
            // `midRecording` says this was working and is now gone — the
            // renderer words that differently from a start-up refusal.
            if (code === 2) {
              onStatus({ ok: false, reason: 'permission', which: missingPermission, midRecording: wasCapturing });
            } else if (!wasCapturing && !namedFailure) {
              // It died before it ever captured and without naming a reason —
              // a crash, a kill. Silence here left the caller believing
              // system audio was on its way: the display was held awake for a
              // source that never arrived and nobody was told the recording
              // is one-sided. A helper that did name its failure has been
              // reported already; saying it twice only repeats the panel.
              onStatus({ ok: false, reason: 'helper-exit', detail: `exit ${code}` });
            }
          }
          settle(false);

          // Dying mid-recording is the dangerous case: take() starts returning
          // null, the microphone alone carries on, and the recording quietly
          // becomes half a conversation. One silent retry covers a transient
          // fault — the far side loses a second, not the rest of the meeting —
          // and if it will not come back, say so rather than let the user find
          // out afterwards.
          // A permission exit is deterministic: the same helper started the
          // same way will refuse the same way. Restarting it would only
          // repeat the sequence and spend the one retry a transient fault
          // deserves.
          if (wasCapturing && !stopping && code !== 2) {
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
        startTimer = setTimeout(() => {
          startTimer = null;
          if (!mine()) return;
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
      if (startTimer) { clearTimeout(startTimer); startTimer = null; }
      if (proc) {
        try { proc.kill(); } catch { /* already gone */ }
        proc = null;             // its handlers see they are no longer current
      }
    }
  };

  return api;
}

module.exports = { create, mixPcm, reapOrphans, MAX_BUFFERED };
