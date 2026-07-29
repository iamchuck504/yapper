"""Feed a real recording into transcribe_stream.py at real-time speed and
report how far behind the live audio each update lands."""
import os
import subprocess
import sys
import threading
import time

import numpy as np
from faster_whisper.audio import decode_audio

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(HERE, "..", "transcribe_stream.py")

audio_path = sys.argv[1]
seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 30.0
model = sys.argv[3] if len(sys.argv) > 3 else "medium"

audio = decode_audio(audio_path, sampling_rate=16000)[: int(seconds * 16000)]
pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)

proc = subprocess.Popen(
    [sys.executable, WORKER, model, "en"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
)

t0 = time.time()
fed = [0.0]


def drain_stdout():
    for line in proc.stdout:
        txt = line.decode("utf-8", "replace").strip()
        if txt:
            print(f"[{time.time() - t0:6.2f}s fed={fed[0]:6.2f}s] {txt}")


def drain_stderr():
    for line in proc.stderr:
        txt = line.decode("utf-8", "replace").strip()
        if txt:
            print(f"  (stderr) {txt}")


threading.Thread(target=drain_stdout, daemon=True).start()
threading.Thread(target=drain_stderr, daemon=True).start()

step = 1600
start = time.time()
for i in range(0, len(pcm), step):
    proc.stdin.write(pcm[i:i + step].tobytes())
    proc.stdin.flush()
    fed[0] = (i + step) / 16000
    delay = start + fed[0] - time.time()
    if delay > 0:
        time.sleep(delay)

proc.stdin.close()
time.sleep(3)
proc.terminate()
print("done")
