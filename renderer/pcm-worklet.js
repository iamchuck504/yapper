// Taps the mixed audio graph and posts mono Float32 blocks to the main thread.
// Runs on the audio thread so the live transcript never stutters the UI.
class PCMTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.parts = [];
    this.count = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const a = input[0];
      const b = input[1];
      const mono = new Float32Array(a.length);
      for (let i = 0; i < a.length; i++) mono[i] = b ? (a[i] + b[i]) / 2 : a[i];
      this.parts.push(mono);
      this.count += mono.length;
      if (this.count >= 4096) {
        const merged = new Float32Array(this.count);
        let o = 0;
        for (const p of this.parts) { merged.set(p, o); o += p.length; }
        this.port.postMessage(merged, [merged.buffer]);
        this.parts = [];
        this.count = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-tap', PCMTap);
