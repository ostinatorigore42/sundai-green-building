/////////////////////////////////////////////////////////////////
/*
IA Assistant
*/
/////////////////////////////////////////////////////////////////

import 'dotenv/config';
import path from 'path';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
const app = express();
// Create WAV file writer
import fs from 'fs';
import { AudioManager, SampleRate } from './audio';
import { processSpeechPipeline, transcribeWithWhisper, boostAudioBuffer } from './openai';
import type { HistoryMessage } from './groq';
import { SileroVAD } from './vad_silero';

const WS_PORT = parseInt(process.env.WS_PORT || "8888");
const MONITOR_WS_PORT = parseInt(process.env.MONITOR_WS_PORT || "8899");
const HTTP_PORT = parseInt(process.env.HTTP_PORT || "8000");

// VAD Configuration: true = WebRTC VAD, false = 5-second timer (reliable fallback)
let USE_VAD = process.env.USE_VAD !== 'false';  // Let instead of const for runtime fallback

// Test mode: true = Whisper transcription only (no AI response), false = normal mode with AI response
const TEST_MODE = process.env.TEST_MODE === 'true';
console.log(`[CONFIG] TEST_MODE=${TEST_MODE} (process.env.TEST_MODE="${process.env.TEST_MODE}")`);

/*
 * One port, not three.
 *
 * This used to open three independent listeners — device on 8888, monitor on
 * 8899, express on 8000 — which is fine on a laptop and impossible anywhere
 * else: Replit, Fly, Railway and the rest all hand you exactly one port and
 * route everything through it. Both sockets now hang off the express server
 * and are told apart by path in the `upgrade` handler at the bottom of this
 * file.
 *
 * The old port constants are still read so a local run behaves exactly as it
 * always did; they are simply ignored when PORT is set by a host.
 */
const wsServer = new WebSocketServer({ noServer: true });
const monitorWsServer = new WebSocketServer({ noServer: true });

/*
 * A shared key, because deploying makes this reachable by anyone with the URL.
 *
 * The source and the API keys stay private on the host, but an open /device
 * lets a stranger spend your Groq and Cartesia credits, and an open /monitor
 * hands them every transcript that passes through. One query parameter closes
 * both. Leave SHARED_KEY unset and the check is skipped, so nothing changes
 * for a local run or for the toy on a LAN.
 *
 *   wss://<host>/device?k=<key>
 *   wss://<host>/monitor?k=<key>
 *
 * The ESP32 firmware needs the same parameter appended to its URL.
 */
const SHARED_KEY = process.env.SHARED_KEY || "";

// arrays of connected websocket clients
let deviceClients: WebSocket[] = [];
let monitorClients: WebSocket[] = [];
let recording: boolean = false;
let processingAudio: boolean = false;  // Prevent concurrent processing

const MAX_HISTORY_TURNS = 15;
let conversationHistory: HistoryMessage[] = [];

const audioManager = new AudioManager();
let vad: SileroVAD | null = null;
let recordingTimer: NodeJS.Timeout | null = null;
let vadInitializing: boolean = false;  // Race condition guard
let sessionChunkCount: number = 0;    // Chunks received this session (for warmup discard)
const VAD_WARMUP_CHUNKS = 1;          // Skip first ~0.5s from VAD to avoid DMA settling noise

async function handleButtonStateChange(ws: WebSocket, buttonState: boolean) {
  notifyButtonStateChange(ws, buttonState);

  if (buttonState) {
    await startRecordingSession();
  } else {
    // Ignore button release - VAD will handle stopping based on silence detection
    console.log('[SERVER] Button released, but VAD controls recording duration (ignoring STOP signal)');
  }
}

function notifyButtonStateChange(ws: WebSocket, buttonState: boolean) {
  console.log(`Button ${buttonState ? "pressed" : "released"}`);
  const message = JSON.stringify({
    type: "button_state_change",
    state: buttonState ? "pressed" : "released"
  });
  ws.send(message);

  // Broadcast to monitor clients for dashboard
  monitorClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

/**
 * Notify monitor clients (dashboard)
 */
function notifyMonitors(message: any) {
  const payload = JSON.stringify(message);
  monitorClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

async function startRecordingSession() {
  // Guard against concurrent initialization or duplicate START signals
  if (recording || processingAudio || vadInitializing) {
    console.warn('[SERVER] Cannot start recording - already recording, processing, or initializing');
    return;
  }

  const useVAD = process.env.USE_VAD !== 'false';  // Default to true

  if (useVAD) {
    try {
      // Start capturing audio IMMEDIATELY — don't lose speech during VAD init
      recording = true;
      sessionChunkCount = 0;
      audioManager.startRecording();

      vadInitializing = true;
      vad = new SileroVAD((event) => notifyMonitors(event));  // Pass event callback
      await vad.init();  // Initialize Silero VAD
      vadInitializing = false;

      console.log('[SERVER] Recording started with Silero VAD');

      notifyMonitors({
        type: 'recording_started',
        timestamp: Date.now(),
        mode: 'silero-vad'
      });
    } catch (error) {
      console.error('[SERVER] Failed to initialize Silero VAD:', error);
      vadInitializing = false;
      vad = null;
      recording = false;

      // Fallback to 5-second timer
      console.warn('[SERVER] Falling back to 5-second timer');
      startTimerMode();
    }
  } else {
    // FALLBACK: Simple 5-second timer
    startTimerMode();
  }
}

function startTimerMode() {
  recording = true;
  audioManager.startRecording();
  console.log('[SERVER] Recording started with 5-second timer (VAD disabled)');

  // Send timer mode config to dashboard
  notifyMonitors({
    type: 'vad_config',
    mode: '5sec-timer',
    timerMs: 5000
  });

  recordingTimer = setTimeout(async () => {
    if (recording) {
      console.log('[SERVER] 5-second timer expired, stopping recording');
      recording = false;
      processingAudio = true;
      audioManager.closeFile();

      const buffer = audioManager.getCurrentBuffer();
      const wavBuffer = createWAVBuffer(buffer, 44100, 1, 16);
      await processAudioWithPipeline(wavBuffer);

      notifyMonitors({
        type: 'response_complete',
        timestamp: Date.now()
      });

      processingAudio = false;

      // Auto-restart
      setTimeout(async () => {
        if (!recording && !processingAudio) {
          console.log('[SERVER] Ready for next utterance');
          await startRecordingSession();
        }
      }, 500);
    }
  }, 5000);

  notifyMonitors({
    type: 'recording_started',
    timestamp: Date.now(),
    mode: '5sec-timer'
  });
}

async function processAudioWithPipeline(audioBuffer: Buffer) {
    if (processingAudio) {
        console.warn('[SERVER] Already processing, skipping');
        return;
    }

    processingAudio = true;
    console.log(`[SERVER] Processing ${audioBuffer.length} bytes`);

    try {
        // TEST_MODE: Use Whisper for transcription only
        if (TEST_MODE) {
            console.log('[TEST MODE] Using Whisper for transcription only (no AI response)');
            const transcript = await transcribeWithWhisper(audioBuffer);

            console.log(`[WHISPER] Transcription: "${transcript}"`);
            notifyMonitors({
                type: 'transcription',
                transcript: transcript,
                responseText: '(test mode - no AI response generated)',
                timestamp: Date.now()
            });

            processingAudio = false;
            return;
        }

        // Notify: Processing started
        notifyMonitors({
            type: 'processing_started',
            timestamp: Date.now(),
            audioSize: audioBuffer.length
        });

        // Run pipeline: Whisper → Groq Llama → TTS
        const { transcription, responseText, emotion, caption, icons, song, friend, audioStream } = await processSpeechPipeline(audioBuffer, conversationHistory);

        // Append turn to conversation history (rolling cap)
        conversationHistory.push({ role: 'user', content: transcription });
        conversationHistory.push({ role: 'assistant', content: responseText });
        while (conversationHistory.length > MAX_HISTORY_TURNS * 2) conversationHistory.splice(0, 2);

        // Notify: Transcription complete
        notifyMonitors({
            type: 'transcription_complete',
            timestamp: Date.now(),
            transcription
        });

        // Notify: Response generated
        notifyMonitors({
            type: 'response_generated',
            timestamp: Date.now(),
            response: responseText,
            emotion,
            caption,  // tower display: short sign text
            icons,    // tower display: pixel icon names
            song,     // tower display: true while playing a songs/ clip instead of TTS
            friend    // tower display: show Tim the Beaver next to SamSam
        });

        // Emit emotion to device before first audio frame — triggers eye reaction
        deviceClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'emotion', emotion }));
            }
        });

        // Stream TTS to ESP32
        console.log(`[SERVER] Streaming TTS to device | emotion: ${emotion}`);
        notifyMonitors({
            type: 'tts_streaming_started',
            timestamp: Date.now()
        });

        let totalAudioBytes = 0;
        const TTS_GAIN = 1.0;  // was 4.0 — clipped hard on louder speakers / sonic-3.5
        let leftoverByte: Buffer | null = null;  // keep int16 samples aligned across odd-length chunks

        audioStream.on('data', (chunk: Buffer) => {
            totalAudioBytes += chunk.length;
            let data = leftoverByte ? Buffer.concat([leftoverByte, chunk]) : chunk;
            leftoverByte = null;
            if (data.length % 2 !== 0) {
                leftoverByte = data.subarray(data.length - 1);
                data = data.subarray(0, data.length - 1);
            }
            if (data.length > 0) {
                broadcastStreamAudioToClients(boostAudioBuffer(data, TTS_GAIN));
                // Tower display: loudness of this chunk (0..1) so the mascot's mouth follows the voice
                let sum = 0;
                for (let i = 0; i + 1 < data.length; i += 2) {
                    const s = data.readInt16LE(i) / 32768;
                    sum += s * s;
                }
                notifyMonitors({
                    type: 'tts_level',
                    rms: Math.sqrt(sum / Math.max(1, data.length / 2)),
                    bytes: data.length,
                    timestamp: Date.now()
                });
            }
        });

        audioStream.on('end', () => {
            console.log('[SERVER] TTS streaming complete');
            notifyMonitors({
                type: 'tts_streaming_complete',
                timestamp: Date.now(),
                audioBytes: totalAudioBytes,  // PCM16 @ 24kHz: seconds = bytes / 48000
                sampleRate: 24000
            });

            processingAudio = false;

            // With true streaming, chunks arrive progressively so most audio
            // has already played by the time stream ends. Small delay for DMA buffer drain.
            setTimeout(() => {
                console.log('[SERVER] Ready for next START signal from ESP32');
                deviceClients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'ready',
                            timestamp: Date.now()
                        }));
                    }
                });
            }, 650); // 650ms for ESP32 DMA buffer (~427ms) + margin for TTS echo tail
        });

        audioStream.on('error', (error) => {
            console.error('[SERVER] TTS error:', error);
            processingAudio = false;

            // Signal ESP32 ready even on error to prevent stuck state
            deviceClients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'ready',
                        timestamp: Date.now()
                    }));
                }
            });
        });
    } catch (error: any) {
        console.error('[SERVER] Pipeline error:', error.message);

        notifyMonitors({
            type: 'processing_error',
            timestamp: Date.now(),
            error: error.message
        });

        processingAudio = false;
        console.log('[SERVER] Ready for next START signal from ESP32');

        // Signal ESP32 ready even on error to prevent stuck state
        deviceClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'ready',
                    timestamp: Date.now()
                }));
            }
        });
    }
}

function extractAudioFromChunk(chunk: any): Buffer | null {
    const delta = chunk.choices[0]?.delta;
    if (!delta?.audio?.data) {
        return null;
    }

    // Audio chunk received (logging disabled to reduce spam)
    return Buffer.from(delta.audio.data, 'base64');
}

/**
 * Amplify audio buffer to boost microphone input for VAD processing
 * Applies gain with normalization to prevent clipping
 */
function amplifyAudioBuffer(buffer: Buffer, gain: number = 50.0): Buffer {
    const samples = new Int16Array(buffer.length / 2);

    // Read int16 samples from buffer
    for (let i = 0; i < buffer.length; i += 2) {
        samples[i / 2] = buffer.readInt16LE(i);
    }

    // Calculate max amplitude for normalization
    const maxAmplitude = Math.max(...Array.from(samples).map(Math.abs));

    if (maxAmplitude < 10) {
        // Pure silence, return as-is
        return buffer;
    }

    // Apply gain with normalization to prevent clipping
    const normalizeRatio = Math.min((32767 / maxAmplitude) * gain, 100.0);  // Cap at 100x
    const amplifiedSamples = new Int16Array(samples.length);

    for (let i = 0; i < samples.length; i++) {
        // Apply gain and clamp to prevent clipping
        const amplified = samples[i] * normalizeRatio;
        amplifiedSamples[i] = Math.max(-32767, Math.min(32767, Math.round(amplified)));
    }

    // Convert back to Buffer
    const outputBuffer = Buffer.alloc(buffer.length);
    for (let i = 0; i < amplifiedSamples.length; i++) {
        outputBuffer.writeInt16LE(amplifiedSamples[i], i * 2);
    }

    return outputBuffer;
}

async function handleAudioData(data: Buffer) {
  if (!recording) return;

  try {
    // STEP 1: Amplify audio FIRST (fixes quiet microphone issue)
    const amplifiedData = amplifyAudioBuffer(data, 50.0);  // 50x gain

    // STEP 2: Save amplified audio to WAV file
    audioManager.handleAudioBuffer(amplifiedData);

    // STEP 3: Feed raw audio (with moderate boost) to VAD
    // Note: over-amplified audio collapses dynamic range and makes noise look like speech
    if (USE_VAD && vad) {
      // Skip processing if VAD is still initializing (prevents race condition errors)
      if (vadInitializing) {
        // Audio is being buffered in audioManager, VAD will process when ready
        return;
      }

      // Warmup discard: skip first chunk (~0.5s) to let DMA buffer settle
      sessionChunkCount++;
      if (sessionChunkCount <= VAD_WARMUP_CHUNKS) {
        return;
      }

      const vadData = amplifyAudioBuffer(data, 25.0);  // 25x from raw, not 50x amplified
      const result = await vad.addChunk(vadData);

      if (result.isDone) {
        if (!recording) return;  // Race guard: concurrent addChunk calls
        // VAD detected end of speech!
        console.log(`[SERVER] VAD stopped recording: ${result.reason}`);

        // Stop recording immediately
        recording = false;
        audioManager.closeFile();

        // CRITICAL: Tell ESP32 to stop streaming to prevent audio feedback during response playback
        deviceClients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'stop_recording',
              reason: result.reason
            }));
            console.log('[SERVER] Sent STOP signal to ESP32');
          }
        });

        // Clear any timers
        if (recordingTimer) {
          clearTimeout(recordingTimer);
          recordingTimer = null;
        }

        // Notify monitors
        notifyMonitors({
          type: 'recording_stopped',
          reason: result.reason,
          duration: vad.getStats().duration,
          timestamp: Date.now()
        });

        // No-speech restart: if VAD never confirmed real speech (only misfires or pure noise),
        // skip the pipeline entirely and send ready immediately
        if (!result.hasSpeech) {
          console.log('[SERVER] No confirmed speech detected — skipping pipeline, sending ready');
          deviceClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'ready', timestamp: Date.now() }));
            }
          });
          processingAudio = false;
        }

        // Process the audio (with minimum length check)
        else if (result.audio && result.audio.length > 0) {
          // Minimum audio length: 0.5 seconds at 44.1kHz, 16-bit mono = 44,100 bytes
          const MIN_AUDIO_BYTES = 44100;

          if (result.audio.length < MIN_AUDIO_BYTES) {
            console.warn(`[SERVER] Audio too short (${result.audio.length} bytes < ${MIN_AUDIO_BYTES}), skipping OpenAI`);
          } else {
            console.log(`[SERVER] Processing ${result.audio.length} bytes of audio (${(result.audio.length / 88200).toFixed(1)}s)`);

            // Convert to WAV and send to OpenAI
            await processVADAudio(result.audio);
          }
        } else {
          console.warn('[SERVER] No audio to process');
        }

        // Cleanup VAD
        if (vad) {
          vad.reset();
          vad.destroy();
          vad = null;
        }

        console.log('[SERVER] Ready for next utterance — waiting for device START signal');
      }
    }
    // Else: 5-second timer mode - just accumulate audio
  } catch (error) {
    console.error('[SERVER] Error in handleAudioData:', error);

    // Recovery: reset state
    recording = false;
    processingAudio = false;

    if (recordingTimer) {
      clearTimeout(recordingTimer);
      recordingTimer = null;
    }

    if (vad) {
      vad.reset();
      vad.destroy();
      vad = null;
    }
  }
}

/**
 * Process audio captured by VAD
 */
async function processVADAudio(audioBuffer: Buffer) {
  try {
    // Create WAV header for the raw PCM data
    // VAD gives us 44.1kHz, 16-bit, mono PCM
    const wavBuffer = createWAVBuffer(audioBuffer, 44100, 1, 16);

    // Send to OpenAI with streaming
    await processAudioWithPipeline(wavBuffer);

    notifyMonitors({
      type: 'response_complete',
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('[SERVER] Error processing VAD audio:', error);
    notifyMonitors({
      type: 'processing_error',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: Date.now()
    });
  }
}

/**
 * Create WAV file buffer from raw PCM
 */
function createWAVBuffer(pcmData: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmData.length;

  const header = Buffer.alloc(44);

  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);

  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);  // fmt chunk size
  header.writeUInt16LE(1, 20);   // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmData]);
}

function broadcastAudioToClients(buffer: Buffer) {
  const CHUNK_SIZE = 2048; // Send 1KB chunks
  const DELAY_MS = 10; // 50ms delay between chunks

  deviceClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      // client.send(buffer);
      // Split buffer into chunks and send with delay
      for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
        const chunk = buffer.slice(i, i + CHUNK_SIZE);
        setTimeout(() => {
          client.send(chunk);
        }, (i / CHUNK_SIZE) * DELAY_MS);
      }
    }
  });
}
function broadcastStreamAudioToClients(buffer: Buffer) {
  const CHUNK_SIZE = 2048; // Send 1KB chunks
  const DELAY_MS = 10; // 50ms delay between chunks

  deviceClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(buffer);
      // Split buffer into chunks and send with delay
      // for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
      //   const chunk = buffer.slice(i, i + CHUNK_SIZE);
      //   setTimeout(() => {
      //     client.send(chunk);
      //   }, (i / CHUNK_SIZE) * DELAY_MS);
      // }
    }
  });
}

wsServer.on("connection", (ws: WebSocket, req) => {
  console.log("Device Connected");
  deviceClients.push(ws);

  // Clean up old recordings (keep last 10)
  AudioManager.cleanupRecordings().catch(err => {
    console.error('[SERVER] Failed to cleanup recordings:', err);
  });

  // Notify monitor clients
  monitorClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "device_connected" }));
    }
  });

  ws.on("message", async (data) => {
    if (data instanceof Buffer) {
      if (data.length === 1) {
        // Handle START/STOP signals - 0 means stop, 1 means start
        const buttonState = data.readUInt8(0) === 1;
        console.log(`[SIGNAL] Received ${buttonState ? 'START' : 'STOP'} signal`);
        handleButtonStateChange(ws, buttonState);
      } else if (recording) {
        // Accumulate audio data while recording
        handleAudioData(data);
      }
    } else {
      // Handle text/JSON messages
      try {
        const message = JSON.parse(data.toString());
        console.log("Received message:", message);
      } catch (err) {
        console.error("Error parsing message:", err);
      }
    }

    // Clean up disconnected clients
    deviceClients = deviceClients.filter(client => {
      if (client.readyState === WebSocket.OPEN) {
        return true;
      }
      console.log('Client disconnected, removing from device clients');
      return false;
    });
  });

  // Close file when connection ends
  ws.on("close", () => {
    console.log('[SERVER] Device disconnected, cleaning up state');

    // Clean up recording state
    if (recording) {
      audioManager.closeFile();
      recording = false;
      // Nothing will ever read this one — the device left mid-utterance — so
      // it would otherwise sit on disk until the next connect swept it.
      AudioManager.cleanupRecordings().catch(() => {});
    }

    // Reset all state flags to allow new connection
    processingAudio = false;
    vadInitializing = false;
    conversationHistory = [];

    // Clean up VAD session if active
    if (vad) {
      try {
        vad.reset();
      } catch (err) {
        // Ignore errors if VAD already stopped
      }
      vad = null;
    }

    // Notify monitor clients
    monitorClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "device_disconnected" }));
      }
    });
  });
});

monitorWsServer.on("connection", (ws: WebSocket) => {
  console.log("Monitor Connected");
  monitorClients.push(ws);
});

// HTTP stuff
app.use("/image", express.static("image"));
app.use("/js", express.static(path.join(__dirname, "js")));
app.get("/", (req, res) =>
  res.sendFile(path.resolve(__dirname, "./dashboard.html"))
);
app.get("/audio", (req, res) =>
  res.sendFile(path.resolve(__dirname, "./audio_client.html"))
);

/*
 * The push-to-talk client, served from the server itself.
 *
 * Same origin matters twice over. A page on https cannot open a ws:// socket —
 * the browser blocks it as mixed content, silently — so the client has to come
 * from the same host it talks to. And getUserMedia refuses to run outside a
 * secure context, so a phone can only use the microphone if the page arrived
 * over https. Serving it here satisfies both at once, and the client derives
 * its own socket URLs from location, so there is nothing to type on a phone.
 */
app.get("/talk", (req, res) =>
  res.sendFile(path.resolve(__dirname, "./toy_client.html"))
);

const PORT = parseInt(process.env.PORT || String(HTTP_PORT));
const server = app.listen(PORT, () => {
  console.log(`HTTP server listening at http://localhost:${PORT}`);
  console.log(`  push-to-talk client   /talk`);
  console.log(`  device socket         /device${SHARED_KEY ? "?k=<SHARED_KEY>" : ""}`);
  console.log(`  monitor socket        /monitor${SHARED_KEY ? "?k=<SHARED_KEY>" : ""}`);
  if (!SHARED_KEY) console.log(`  [warn] SHARED_KEY unset — both sockets are open to anyone who can reach this host`);
});

/*
 * Route WebSocket upgrades by path, and check the key before either socket
 * server ever sees the connection.
 */
server.on("upgrade", (req, socket, head) => {
  let pathname: string, key: string | null;
  try {
    const url = new URL(req.url || "/", "http://localhost");
    pathname = url.pathname;
    key = url.searchParams.get("k");
  } catch {
    return socket.destroy();
  }

  if (SHARED_KEY && key !== SHARED_KEY) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }

  const target =
    pathname === "/device"  ? wsServer :
    pathname === "/monitor" ? monitorWsServer : null;

  if (!target) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    return socket.destroy();
  }

  target.handleUpgrade(req, socket, head, ws => target.emit("connection", ws, req));
});

/*
 * The tower bridge, as a child of this server.
 *
 * bridge.py subscribes to /monitor and POSTs 17x9 frames to the Green Building
 * simulator. It could run anywhere with outbound internet — but "anywhere"
 * in practice meant somebody's laptop, and a display that only works while a
 * particular laptop is awake is not a deployment. Running it here means the
 * tower is lit for as long as the service is up, and starting the service is
 * the only thing anyone has to do.
 *
 * It connects back over 127.0.0.1 rather than the public hostname: same
 * process tree, no TLS, no round trip through the proxy.
 *
 * Set BRIDGE_INSTANCE to the simulator instance name to switch this on. Leave
 * it unset and nothing is spawned, which is what you want when someone else is
 * driving that instance — two bridges aimed at one instance make the building
 * flicker between them.
 */
const BRIDGE_INSTANCE = process.env.BRIDGE_INSTANCE || "";

if (BRIDGE_INSTANCE) {
  const { spawn } = require("child_process") as typeof import("child_process");
  const py = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
  const script = path.resolve(__dirname, "../tower/bridge.py");
  const monitorUrl = `ws://127.0.0.1:${PORT}/monitor` + (SHARED_KEY ? `?k=${SHARED_KEY}` : "");

  let stopping = false;
  let backoff = 1000;

  const startBridge = () => {
    if (stopping) return;
    console.log(`[bridge] starting on instance "${BRIDGE_INSTANCE}"`);
    const child = spawn(py, [script, BRIDGE_INSTANCE, "--monitor", monitorUrl, "--no-intro"], {
      cwd: path.resolve(__dirname, "../tower"),
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    child.stdout.on("data", d => process.stdout.write(`[bridge] ${d}`));
    child.stderr.on("data", d => process.stderr.write(`[bridge] ${d}`));

    child.on("exit", code => {
      if (stopping) return;
      // A crashed bridge is a dark building, and the usual cause is a blip in
      // the outbound connection to the simulator rather than anything fatal.
      console.error(`[bridge] exited (${code}); restarting in ${backoff}ms`);
      setTimeout(startBridge, backoff);
      backoff = Math.min(backoff * 2, 30000);
    });

    child.on("error", err => console.error(`[bridge] could not start ${py}: ${err.message}`));

    // Survived a minute: whatever went wrong before is not going wrong now.
    setTimeout(() => { backoff = 1000; }, 60000);

    const stop = () => { stopping = true; child.kill(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("exit", stop);
  };

  // A moment's grace so the monitor socket is accepting before it dials in.
  setTimeout(startBridge, 500);
}