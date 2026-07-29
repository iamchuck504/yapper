"""Streaming transcription worker (low-latency live preview).

Reads raw PCM (16 kHz, mono, signed 16-bit LE) from stdin continuously and
writes one JSON line per pass to stdout:

    {"commit": "words just confirmed", "tentative": "unstable tail"}

Latency comes from the inference cadence (~0.7 s), not from block size, so the
transcript trails live speech by roughly 1-2 s.

Technique: a rolling audio buffer is re-transcribed every pass, and a word is
only *confirmed* once two consecutive passes agree on it at the same position
(LocalAgreement-2). Confirmed text never changes; the tentative tail may.

Usage: python transcribe_stream.py [model] [language|auto] [initial_prompt]
"""
import json
import os
import sys
import threading
import time

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

import numpy as np
from faster_whisper import WhisperModel

SAMPLE_RATE = 16000
CPU_MODEL = "small"    # fallback when there is no GPU
PARAGRAPH_GAP = 1.4    # a pause longer than this starts a new paragraph
INFER_EVERY = 0.7      # seconds between inference passes
MIN_AUDIO = 1.0        # don't infer on less audio than this
MAX_BUFFER = 26.0      # trim once the buffer grows past this
TRIM_KEEP = 12.0       # fallback: keep this much when nothing is confirmed
EDGE_GUARD = 0.35      # never confirm words this close to the buffer edge


def add_nvidia_dll_dirs():
    """Make the pip-installed cuBLAS/cuDNN DLLs visible to ctranslate2."""
    try:
        import nvidia
    except ImportError:
        return
    for base in getattr(nvidia, "__path__", []):
        for sub in ("cublas", "cudnn"):
            d = os.path.join(base, sub, "bin")
            if os.path.isdir(d):
                os.add_dll_directory(d)
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


class AudioBuffer:
    """Thread-safe rolling buffer of float32 samples."""

    def __init__(self):
        self._lock = threading.Lock()
        self._data = np.zeros(0, dtype=np.float32)
        self.eof = False

    def append(self, samples):
        with self._lock:
            self._data = np.concatenate((self._data, samples))

    def snapshot(self):
        with self._lock:
            return self._data.copy()

    def drop_front(self, n_samples):
        with self._lock:
            self._data = self._data[n_samples:]

    def __len__(self):
        with self._lock:
            return len(self._data)


def reader_thread(buf):
    """Pump stdin bytes into the buffer until the pipe closes."""
    stream = sys.stdin.buffer
    leftover = b""
    while True:
        chunk = stream.read(8192)
        if not chunk:
            break
        data = leftover + chunk
        usable = len(data) - (len(data) % 2)   # keep int16 frames aligned
        leftover = data[usable:]
        if usable:
            samples = np.frombuffer(data[:usable], dtype=np.int16).astype(np.float32) / 32768.0
            buf.append(samples)
    buf.eof = True


def normalize(word):
    return "".join(c for c in word.lower() if c.isalnum())


def common_prefix(a, b):
    n = 0
    while n < len(a) and n < len(b) and normalize(a[n][0]) == normalize(b[n][0]):
        n += 1
    return n


def is_degenerate(words):
    """Detect Whisper's repetition loops ("the, the, the, ...")."""
    norm = [normalize(w[0]) for w in words]
    norm = [w for w in norm if w]
    if len(norm) < 6:
        return False
    run = best = 1
    for i in range(1, len(norm)):
        run = run + 1 if norm[i] == norm[i - 1] else 1
        best = max(best, run)
    if best >= 5:
        return True
    counts = {}
    for w in norm:
        counts[w] = counts.get(w, 0) + 1
    return len(norm) >= 12 and max(counts.values()) / len(norm) > 0.5


def main() -> int:
    model_size = sys.argv[1] if len(sys.argv) > 1 else "small"
    language = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != "auto" else None
    base_prompt = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else ""

    add_nvidia_dll_dirs()
    # A GPU pass on `medium` costs ~0.3 s, well inside the 0.7 s cadence, and is
    # clearly more accurate. CPU cannot keep up with it, so it drops to `small`.
    try:
        model = WhisperModel(model_size, device="cuda", compute_type="float16")
        device, beam = "cuda", 5
    except Exception as e:
        print(f"GPU unavailable for streaming worker ({e}); using CPU", file=sys.stderr)
        model = WhisperModel(CPU_MODEL, device="cpu", compute_type="int8")
        device, beam = "cpu", 1

    buf = AudioBuffer()
    threading.Thread(target=reader_thread, args=(buf,), daemon=True).start()
    emit({"status": "ready", "device": device})

    buf_offset = 0.0        # absolute time of the buffer's first sample
    last_commit_end = 0.0   # absolute end time of the last confirmed word
    prev_hyp = []           # previous pass's unconfirmed words

    while True:
        time.sleep(INFER_EVERY)
        audio = buf.snapshot()
        if len(audio) < MIN_AUDIO * SAMPLE_RATE:
            if buf.eof:
                break
            continue

        # Skip passes where nothing new was spoken: re-decoding silence is the
        # main trigger for Whisper hallucinations, and the result wouldn't change.
        recent = audio[-int(1.5 * SAMPLE_RATE):]
        if float(np.sqrt(np.mean(recent ** 2))) < 0.004:
            if buf.eof:
                break
            continue

        # NOTE: never feed confirmed text back as the prompt — it makes the model
        # echo its own output and spiral into repetition loops.
        t_pass = time.time()
        try:
            segments, _ = model.transcribe(
                audio,
                language=language,
                initial_prompt=base_prompt or None,
                word_timestamps=True,
                condition_on_previous_text=False,
                beam_size=beam,
                temperature=[0.0, 0.2, 0.4, 0.6],
                compression_ratio_threshold=2.4,
                repetition_penalty=1.15,
                no_repeat_ngram_size=3,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 300},
            )
            words = [
                (w.word.strip(), w.start + buf_offset, w.end + buf_offset)
                for seg in segments for w in (seg.words or [])
                if w.word.strip()
            ]
        except Exception as e:
            emit({"error": str(e)})
            if buf.eof:
                break
            continue

        elapsed = time.time() - t_pass
        if elapsed > INFER_EVERY:
            print(f"slow pass: {elapsed:.2f}s on {len(audio) / SAMPLE_RATE:.1f}s "
                  f"of audio — live text will lag", file=sys.stderr)

        buf_end_abs = buf_offset + len(audio) / SAMPLE_RATE
        fresh = [w for w in words if w[2] > last_commit_end + 0.02]

        # Drop a bad decode instead of confirming garbage; the next pass recovers.
        if is_degenerate(fresh):
            prev_hyp = []
            if len(audio) / SAMPLE_RATE > MAX_BUFFER:
                keep = int(TRIM_KEEP * SAMPLE_RATE)
                buf.drop_front(len(audio) - keep)
                buf_offset += (len(audio) - keep) / SAMPLE_RATE
            continue

        # LocalAgreement-2: confirm the prefix this pass shares with the last one,
        # holding back anything still touching the live edge of the buffer.
        n = common_prefix(fresh, prev_hyp)
        while n > 0 and fresh[n - 1][2] > buf_end_abs - EDGE_GUARD:
            n -= 1

        if n:
            confirmed = fresh[:n]
            # a clear pause before this chunk reads better as a new paragraph
            # (bool() because word timestamps are numpy floats -> numpy.bool_)
            gap = bool(last_commit_end > 0 and (confirmed[0][1] - last_commit_end) > PARAGRAPH_GAP)
            last_commit_end = confirmed[-1][2]
            emit({
                "commit": " ".join(w[0] for w in confirmed),
                "tentative": " ".join(w[0] for w in fresh[n:]),
                "gap": gap,
            })
        else:
            emit({"commit": "", "tentative": " ".join(w[0] for w in fresh)})

        prev_hyp = fresh[n:]

        # Keep the buffer bounded: drop everything already confirmed.
        if len(audio) / SAMPLE_RATE > MAX_BUFFER:
            cut = last_commit_end - buf_offset - 0.3
            if cut <= 0:
                cut = len(audio) / SAMPLE_RATE - TRIM_KEEP
            if cut > 0:
                buf.drop_front(int(cut * SAMPLE_RATE))
                buf_offset += cut

        if buf.eof and len(buf) < MIN_AUDIO * SAMPLE_RATE:
            break

    return 0


if __name__ == "__main__":
    sys.exit(main())
