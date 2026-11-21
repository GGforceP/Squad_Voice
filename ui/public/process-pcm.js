class SquadPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(8192);
    this.head = 0;
    this.size = 0;
    this.gain = 0.75;
    this.primed = false;
    this.port.onmessage = ({ data }) => {
      if (typeof data.gain === 'number') {
        this.gain = Math.min(1, Math.max(0, data.gain));
        return;
      }
      const samples = data.samples;
      if (!(samples instanceof Float32Array) || samples.length > 2048) return;
      for (const sample of samples) {
        if (this.size === this.ring.length) { this.head = (this.head + 1) % this.ring.length; this.size--; }
        this.ring[(this.head + this.size) % this.ring.length] = sample;
        this.size++;
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    if (!this.primed && this.size >= 1024) this.primed = true;
    for (let i = 0; i < out.length; i++) {
      if (!this.primed || !this.size) { out[i] = 0; this.primed = false; continue; }
      out[i] = this.ring[this.head] * this.gain;
      this.head = (this.head + 1) % this.ring.length;
      this.size--;
    }
    return true;
  }
}
registerProcessor('squad-pcm', SquadPcm);
