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
    print("no hay grabación grande para probar")
    sys.exit(1)

full = open(src, "rb").read()
print(f"origen: {os.path.basename(os.path.dirname(src))}  {len(full)/1e6:.1f} MB")

cut = int(len(full) * 0.60)
with open(TMP, "wb") as f:
    f.write(full[:cut])
print(f"truncado a {cut/1e6:.1f} MB (como si se hubiera ido la luz)")

try:
    whole = decode_audio(src, sampling_rate=16000)
    part = decode_audio(TMP, sampling_rate=16000)
except Exception as e:
    print(f"FAIL  el archivo truncado no decodifica: {e}")
    sys.exit(1)

print(f"audio completo : {len(whole)/16000/60:6.2f} min")
print(f"audio truncado : {len(part)/16000/60:6.2f} min")

ratio = len(part) / len(whole)
rms = float(np.sqrt(np.mean(part[-16000 * 5:] ** 2))) if len(part) > 16000 * 5 else 0
ok = 0.4 < ratio < 0.8 and len(part) > 16000 * 10

print(f"conserva el {ratio*100:.0f}% del audio, RMS del final = {rms:.4f}")
print("PASS  la grabación interrumpida sigue siendo transcribible" if ok
      else "FAIL  no se recuperó lo esperado")
os.remove(TMP)
sys.exit(0 if ok else 1)
