'use strict';

// Windows counterpart to mac/speaker-diarize. It lives in a worker so model
// loading and inference never freeze Electron's main/UI thread. Audio and the
// two models remain on the machine throughout the run.

const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');

const READ_BLOCK_BYTES = 1024 * 1024;
const MAX_AUDIO_SECONDS = 4 * 60 * 60;

function fail(message) {
  parentPort.postMessage({ type: 'error', reason: String(message || 'speaker detection failed').slice(0, 500) });
}

function waveInfo(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const header = Buffer.alloc(Math.min(size, 1024 * 1024));
    fs.readSync(fd, header, 0, header.length, 0);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('remote track is not a WAV file');
    }
    let offset = 12;
    let format = null;
    let data = null;
    while (offset + 8 <= header.length) {
      const id = header.toString('ascii', offset, offset + 4);
      const chunkSize = header.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (id === 'fmt ' && chunkSize >= 16 && start + 16 <= header.length) {
        format = {
          code: header.readUInt16LE(start),
          channels: header.readUInt16LE(start + 2),
          sampleRate: header.readUInt32LE(start + 4),
          blockAlign: header.readUInt16LE(start + 12),
          bits: header.readUInt16LE(start + 14)
        };
      } else if (id === 'data') {
        data = { offset: start, bytes: Math.min(chunkSize, Math.max(0, size - start)) };
        break;
      }
      offset = start + chunkSize + (chunkSize & 1);
    }
    if (!format || !data) throw new Error('remote WAV is missing format or audio data');
    if (format.code !== 1 || format.channels !== 1 || format.sampleRate !== 16000
        || format.bits !== 16 || format.blockAlign !== 2) {
      throw new Error(`unsupported remote WAV format: PCM ${format.bits}-bit, ${format.channels} channel(s), ${format.sampleRate} Hz`);
    }
    const samples = Math.floor(data.bytes / 2);
    if (samples > format.sampleRate * MAX_AUDIO_SECONDS) {
      throw new Error('remote track is longer than the four-hour safety limit');
    }
    return { fd, dataOffset: data.offset, samples, sampleRate: format.sampleRate };
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

function readSamples(file) {
  const info = waveInfo(file);
  const samples = new Float32Array(info.samples);
  const block = Buffer.alloc(READ_BLOCK_BYTES);
  let done = 0;
  try {
    while (done < info.samples) {
      const wanted = Math.min(block.length, (info.samples - done) * 2);
      const bytes = fs.readSync(info.fd, block, 0, wanted, info.dataOffset + done * 2);
      if (!bytes) throw new Error('remote WAV ended before its declared audio data');
      const count = Math.floor(bytes / 2);
      for (let i = 0; i < count; i++) samples[done + i] = block.readInt16LE(i * 2) / 32768;
      done += count;
      parentPort.postMessage({ type: 'progress', done, total: Math.max(1, info.samples * 10) });
    }
  } finally {
    fs.closeSync(info.fd);
  }
  return samples;
}

function start() {
  const assets = path.resolve(workerData.assetsDir);
  const mainFile = path.join(assets, 'sherpa-onnx-wasm-main-speaker-diarization.js');
  const apiFile = path.join(assets, 'sherpa-onnx-speaker-diarization.js');
  if (!fs.existsSync(mainFile) || !fs.existsSync(apiFile)) throw new Error('local Windows speaker models are unavailable');

  const samples = readSamples(workerData.audioFile);
  parentPort.postMessage({ type: 'progress', done: samples.length, total: Math.max(1, samples.length * 10) });
  const Module = require(mainFile);
  const { createOfflineSpeakerDiarization } = require(apiFile);
  Module.onRuntimeInitialized = () => {
    let diarizer;
    try {
      parentPort.postMessage({ type: 'progress', done: samples.length * 2, total: Math.max(1, samples.length * 10) });
      diarizer = createOfflineSpeakerDiarization(Module, {
        segmentation: {
          pyannote: { model: './segmentation.onnx', windowShiftRatio: 0.1 },
          numThreads: 1,
          debug: 0,
          provider: 'cpu'
        },
        embedding: { model: './embedding.onnx', numThreads: 1, debug: 0, provider: 'cpu' },
        clustering: { numClusters: -1, threshold: 0.5 },
        minDurationOn: 0.3,
        minDurationOff: 0.5
      });
      const segments = diarizer.process(samples).map(segment => ({
        speaker: `cluster-${Number(segment.speaker) + 1}`,
        start: Number(segment.start),
        end: Number(segment.end)
      }));
      parentPort.postMessage({ type: 'progress', done: samples.length * 10, total: Math.max(1, samples.length * 10) });
      parentPort.postMessage({ type: 'result', segments });
    } catch (err) {
      fail(err.stack || err.message);
    } finally {
      try { diarizer?.free(); } catch { /* worker is exiting */ }
    }
  };
}

try { start(); } catch (err) { fail(err.stack || err.message); }
