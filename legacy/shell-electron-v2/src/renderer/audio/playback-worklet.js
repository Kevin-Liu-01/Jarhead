// Ring-buffered PCM16 playback. Chunks arrive every few tens of ms from the
// socket; the buffer absorbs jitter. "flush" empties it (barge-in / stop).
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.flush) {
        this.queue = [];
        this.offset = 0;
        return;
      }
      if (m.pcm) this.queue.push(new Int16Array(m.pcm));
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    for (let i = 0; i < out.length; i++) {
      const head = this.queue[0];
      if (!head) {
        out[i] = 0;
        continue;
      }
      out[i] = head[this.offset++] / 32768;
      if (this.offset >= head.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("jarhead-playback", PlaybackProcessor);
