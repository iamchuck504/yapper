"""Proves the point of streaming to disk: a recording cut off mid-meeting
(power cut, crash) must still be decodable and transcribable.

Takes a real recording, keeps only the first 60% of its bytes — which is what
would survive — and checks the audio still decodes.
"""
import os
import sys

import numpy as np
from faster_whisper.audio import decode_audio

MEETINGS = os.path.join(os.environ["USERPROFILE"], "Documents", "Meetings")
TMP = os.path.join(os.environ["TEMP"], "yapper-truncated.webm")


def pick_recording():
    for name in sorted(os.listdir(MEETINGS), reverse=True):
        p = os.path.join(MEETINGS, name, "recording.webm")
        if os.path.exists(p) and os.path.getsize(p) > 2_000_000:
            return p
    return None


src = pick_recording()
if not src:
    print("no large recording to test with")
    sys.exit(1)

full = open(src, "rb").read()
print(f"origen: {os.path.basename(os.path.dirname(src))}  {len(full)/1e6:.1f} MB")

cut = int(len(full) * 0.60)
with open(TMP, "wb") as f:
    f.write(full[:cut])
print(f"truncated to {cut/1e6:.1f} MB (as if the power had gone out)")

try:
    whole = decode_audio(src, sampling_rate=16000)
    part = decode_audio(TMP, sampling_rate=16000)
except Exception as e:
    print(f"FAIL  the truncated file does not decode: {e}")
    sys.exit(1)

print(f"audio completo : {len(whole)/16000/60:6.2f} min")
print(f"audio truncado : {len(part)/16000/60:6.2f} min")

ratio = len(part) / len(whole)
rms = float(np.sqrt(np.mean(part[-16000 * 5:] ** 2))) if len(part) > 16000 * 5 else 0
ok = 0.4 < ratio < 0.8 and len(part) > 16000 * 10

print(f"keeps {ratio*100:.0f}% of the audio, RMS at the end = {rms:.4f}")
print("PASS  the interrupted recording is still transcribable" if ok
      else "FAIL  did not recover what was expected")
os.remove(TMP)
sys.exit(0 if ok else 1)
