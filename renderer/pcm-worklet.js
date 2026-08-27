// Taps microphone and system audio before they are mixed and posts aligned mono
// Float32 blocks to the main thread.  The mixed block still drives the live
// transcript and recording.wav; the two source blocks let Windows retain the
// same reliable Me/Them distinction as macOS without guessing from voices.
// Runs on the audio thread so the live transcript never stutters the UI.
class PCMTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.parts = { mixed: [], mic: [], sys: [] };
    this.count = 0;
  }

  mono(input, length) {
    if (!input || !input.length) return new Float32Array(length);
    const out = new Float32Array(length);
    for (const channel of input) {
      for (let i = 0; i < length; i++) out[i] += channel[i] || 0;
    }
    if (input.length > 1) {
      for (let i = 0; i < length; i++) out[i] /= input.length;
    }
    return out;
  }

  process(inputs) {
    const length = Math.max(inputs[0]?.[0]?.length || 0, inputs[1]?.[0]?.length || 0);
    if (length) {
      const mic = this.mono(inputs[0], length);
      const sys = this.mono(inputs[1], length);
      const mixed = new Float32Array(length);
      for (let i = 0; i < length; i++) mixed[i] = mic[i] + sys[i];
      this.parts.mic.push(mic);
      this.parts.sys.push(sys);
      this.parts.mixed.push(mixed);
      this.count += length;
      if (this.count >= 4096) {
        const packet = {};
        for (const key of ['mixed', 'mic', 'sys']) {
          packet[key] = new Float32Array(this.count);
          let o = 0;
          for (const part of this.parts[key]) { packet[key].set(part, o); o += part.length; }
        }
        this.port.postMessage(packet,
          [packet.mixed.buffer, packet.mic.buffer, packet.sys.buffer]);
        this.parts = { mixed: [], mic: [], sys: [] };
        this.count = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-tap', PCMTap);
