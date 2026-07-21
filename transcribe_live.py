"""Persistent Whisper worker for semi-live transcription.

Loads the model once, then reads one audio-file path per line from stdin and
prints a JSON line {"text": ...} per chunk to stdout. Used for the live preview
while recording; the authoritative transcript is still produced at stop time.

Usage: python transcribe_live.py [model] [language|auto]
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

from faster_whisper import WhisperModel


def add_nvidia_dll_dirs():
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


def main() -> int:
    model_size = sys.argv[1] if len(sys.argv) > 1 else "small"
    language = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != "auto" else None
    initial_prompt = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None

    add_nvidia_dll_dirs()
    try:
        model = WhisperModel(model_size, device="cuda", compute_type="float16")
    except Exception as e:
        print(f"GPU unavailable for live worker ({e}); using CPU", file=sys.stderr)
        model = WhisperModel(model_size, device="cpu", compute_type="int8")

    print(json.dumps({"status": "ready"}), flush=True)

    for line in sys.stdin:
        audio = line.strip().lstrip("﻿").strip()
        if not audio:
            continue
        try:
            segments, _ = model.transcribe(audio, language=language, initial_prompt=initial_prompt)
            text = " ".join(s.text.strip() for s in segments).strip()
            print(json.dumps({"text": text}), flush=True)
        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)
        finally:
            try:
                os.remove(audio)
            except OSError:
                pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
