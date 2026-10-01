// AudioWorklet global scope: lib.dom does not declare these.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

/** Copies the mono input into ~21 ms blocks (1024 frames at 48 kHz) and posts them to the main thread. No processing: this is a raw capture. */
class CaptureProcessor extends AudioWorkletProcessor {
  private block = new Float32Array(1024);
  private fill = 0;
  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const n = Math.min(ch.length - i, this.block.length - this.fill);
      this.block.set(ch.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === this.block.length) {
        const out = this.block;
        this.port.postMessage(out, [out.buffer]);
        this.block = new Float32Array(1024);
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor('cb-capture', CaptureProcessor);
