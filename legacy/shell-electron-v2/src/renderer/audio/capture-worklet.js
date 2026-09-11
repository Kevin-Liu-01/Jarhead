// Runs on the audio thread. Converts float32 frames to PCM16 at the graph rate and
// posts fixed-size chunks. Level (RMS) is computed here too, so the main thread
// never touches samples.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Int16Array(2400); // 100 ms at 24 kHz
    this.filled = 0;
    this.levelAcc = 0;
    this.levelN = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      let s = ch[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      this.levelAcc += s * s;
      this.levelN++;
      this.chunk[this.filled++] = s < 0 ? s * 32768 : s * 32767;
      if (this.filled === this.chunk.length) {
        const level = Math.min(1, Math.sqrt(this.levelAcc / this.levelN) * 4);
        this.port.postMessage({ pcm: this.chunk.buffer.slice(0), level });
        this.filled = 0;
        this.levelAcc = 0;
        this.levelN = 0;
      }
    }
    return true;
  }
}
registerProcessor("jarhead-capture", CaptureProcessor);
