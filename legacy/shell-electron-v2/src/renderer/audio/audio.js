// The audio window: microphone in, voice out, both at 24 kHz PCM16.
//
// getUserMedia's echo cancellation is what makes full duplex livable in a room
// with speakers: the model would otherwise hear itself. Both directions run on
// AudioWorklets so a busy UI thread cannot glitch the audio.
const RATE = 24000;
const bridge = window.jarheadAudio;

let ctx;
let capture;
let playback;
let stream;

async function start() {
  ctx = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
  await ctx.audioWorklet.addModule("./capture-worklet.js");
  await ctx.audioWorklet.addModule("./playback-worklet.js");

  playback = new AudioWorkletNode(ctx, "jarhead-playback", { numberOfInputs: 0, outputChannelCount: [1] });
  playback.connect(ctx.destination);
  bridge.onPcm((buf) => playback.port.postMessage({ pcm: buf }, [buf]));
  bridge.onControl((msg) => {
    if (msg && msg.type === "flush") playback.port.postMessage({ flush: true });
    if (msg && msg.type === "mic-device") restartMic(msg.deviceId).catch(reportMicError);
  });

  await startMic(await bridge.micDevice());
}

async function startMic(deviceId) {
  const constraints = {
    audio: {
      channelCount: 1,
      sampleRate: RATE,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    reportMicError(e);
    return;
  }
  bridge.reportMic("granted");
  const source = ctx.createMediaStreamSource(stream);
  capture = new AudioWorkletNode(ctx, "jarhead-capture", { numberOfOutputs: 0 });
  let lastLevel = 0;
  capture.port.onmessage = (e) => {
    bridge.sendPcm(e.data.pcm);
    if (Math.abs(e.data.level - lastLevel) > 0.01) {
      lastLevel = e.data.level;
      bridge.reportLevel(e.data.level);
    }
  };
  source.connect(capture);
  if (ctx.state !== "running") await ctx.resume();
}

async function restartMic(deviceId) {
  if (stream) for (const t of stream.getTracks()) t.stop();
  if (capture) capture.disconnect();
  await startMic(deviceId);
}

function reportMicError(e) {
  const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
  bridge.reportMic(denied ? "denied" : "unknown");
  console.error("mic:", e);
}

start().catch((e) => {
  console.error("audio start failed:", e);
  bridge.reportMic("unknown");
});
