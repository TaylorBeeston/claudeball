/** Microphone capture: getUserMedia with every "helpful" processing turned off, into an AudioWorklet that posts raw blocks. */

export interface CaptureSettings {
  deviceId?: string;
  rate: 44100 | 48000;
}

export interface Capture {
  ctx: AudioContext;
  /** what the browser/device actually gave us */
  info: { label: string; contextRate: number; trackRate?: number; echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean; channels?: number };
  onBlock: (block: Float32Array) => void;
  stop(): void;
}

export async function listInputs(): Promise<MediaDeviceInfo[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'audioinput');
}

export async function openCapture(s: CaptureSettings): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: s.deviceId ? { exact: s.deviceId } : undefined,
      channelCount: 1,
      sampleRate: { ideal: s.rate },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  const ctx = new AudioContext({ sampleRate: s.rate, latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule(new URL('./recorder-worklet.ts', import.meta.url));
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'cb-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
  const cap: Capture = {
    ctx,
    info: { label: '', contextRate: ctx.sampleRate },
    onBlock: () => {},
    stop() {
      node.port.onmessage = null;
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
  node.port.onmessage = (e: MessageEvent<Float32Array>) => cap.onBlock(e.data);
  src.connect(node);
  const track = stream.getAudioTracks()[0];
  const st = track.getSettings();
  cap.info = { label: track.label, contextRate: ctx.sampleRate, trackRate: st.sampleRate, echoCancellation: st.echoCancellation as boolean | undefined, noiseSuppression: st.noiseSuppression as boolean | undefined, autoGainControl: st.autoGainControl as boolean | undefined, channels: st.channelCount };
  return cap;
}
