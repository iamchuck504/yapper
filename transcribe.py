"""Transcribe an audio file with faster-whisper.

Usage: python transcribe.py <audio> [model] [language|auto]
Prints each segment as "[hh:mm:ss] text" as it goes.
Uses CUDA (GPU) when available, falling back to CPU automatically.
"""
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

from faster_whisper import BatchedInferencePipeline, WhisperModel


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


def ts(seconds: float) -> str:
    s = int(seconds)
    h, rem = divmod(s, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def transcribe(model_size, device, audio, language, printed):
    if device == "cuda":
        model = WhisperModel(model_size, device="cuda", compute_type="float16")
        pipeline = BatchedInferencePipeline(model=model)
        segments, info = pipeline.transcribe(audio, language=language, batch_size=16)
    else:
        # batched mode crashes on Windows CPU (stack overflow); use the classic path
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segments, info = model.transcribe(audio, vad_filter=True, language=language)
    print(f"Device: {device} | Detected language: {info.language} "
          f"(p={info.language_probability:.2f})", file=sys.stderr)
    for seg in segments:
        text = seg.text.strip()
        if text:
            print(f"[{ts(seg.start)}] {text}", flush=True)
            printed["n"] += 1


def main() -> int:
    if len(sys.argv) < 2:
        print("Missing audio file argument", file=sys.stderr)
        return 1
    audio = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "small"
    language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "auto" else None

    add_nvidia_dll_dirs()
    printed = {"n": 0}
    try:
        transcribe(model_size, "cuda", audio, language, printed)
    except Exception as e:
        if printed["n"] > 0:
            raise  # GPU died mid-transcription; retrying would duplicate output
        print(f"GPU transcription unavailable ({e}); falling back to CPU", file=sys.stderr)
        transcribe(model_size, "cpu", audio, language, printed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
