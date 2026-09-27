# VAD Installation & Testing (Silero VAD)

## Install Dependencies

**Silero VAD via avr-vad - Production-ready deep learning VAD**

```bash
cd server
npm install  # Installs avr-vad (includes ONNX Runtime)
npm run dev  # Start the server
```

## What Changed

### New Features
- **Silero VAD**: State-of-the-art deep learning voice activity detection
- **No Native Dependencies**: Pure JavaScript/TypeScript (no node-gyp)
- **87.7% Accuracy**: vs WebRTC VAD's 50% accuracy
- **Built-in Resampling**: Handles 44.1kHz → 16kHz automatically
- **Dynamic Duration**: Recording stops ~720ms after you stop speaking (fast response)
- **Reliable Fallback**: Set `USE_VAD=false` for 5-second timer mode
- **Auto-restart**: Ready for next utterance immediately after processing

### Files Modified

1. **server/src/vad_silero.ts** (NEW)
   - Silero VAD using avr-vad RealTimeVAD
   - No manual resampling needed
   - Callback-based speech event handling
   - 720ms redemption frames (24 × 30ms) - fast response time

2. **server/src/server.ts**
   - Integrated Silero VAD into audio pipeline
   - Replaced WebRTC VAD with Silero VAD
   - Added automatic fallback to 5-second timer on error
   - Added state protection (prevents concurrent processing)

3. **server/.env**
   - `USE_VAD=true` configuration
   - `true` = Silero VAD, `false` = 5-second timer

4. **server/package.json**
   - Replaced `@echogarden/fvad-wasm` with `avr-vad`

### Files Removed
- ~~server/src/vad_webrtc.ts~~ (removed - replaced with Silero VAD)
- ~~server/src/types/fvad-wasm.d.ts~~ (removed - no longer needed)

## How It Works

```
[ESP32 streams 44.1kHz audio]
    ↓
[Server receives chunks]
    ↓
[Convert int16 PCM to Float32]
    ↓
[Silero VAD analyzes with deep learning model]
    ↓  (avr-vad handles resampling internally)
[Detects speech patterns (87.7% accuracy)]
    ↓
[Waits for 720ms silence (redemption frames)]
    ↓
[Auto-stops & processes with OpenAI]
    ↓
[Ready for next utterance]
```

## Configuration

### Enable/Disable VAD

Edit `server/.env`:

```bash
# Silero VAD (recommended)
USE_VAD=true

# Or fallback to 5-second timer
USE_VAD=false
```

### Adjust VAD Sensitivity

In `vad_silero.ts`, change thresholds:

```typescript
private readonly POSITIVE_SPEECH_THRESHOLD = 0.8;  // 0-1, higher = more confident
private readonly NEGATIVE_SPEECH_THRESHOLD = 0.5;  // Hysteresis for speech end
```

| Threshold | Sensitivity | Use Case |
|-----------|-------------|----------|
| 0.9 | Very conservative | Clean speech only |
| 0.8 | Recommended | Normal indoor (default) |
| 0.7 | Moderate | Some background noise |
| 0.6 | Aggressive | Noisy environments |

### Adjust Silence Threshold

In `vad_silero.ts`, change redemption frames:

```typescript
private readonly REDEMPTION_FRAMES = 24;  // 24 × 30ms = 720ms (default)
```

Examples:
- 0.5 seconds: `REDEMPTION_FRAMES = 16`
- 1.0 second: `REDEMPTION_FRAMES = 33`
- 1.5 seconds: `REDEMPTION_FRAMES = 50`
- 2.0 seconds: `REDEMPTION_FRAMES = 66`

## Testing

### 1. Start Server

```bash
cd server
npm run dev
```

**Expected output:**
```
[VAD] Initializing Silero VAD (threshold=0.8)
[VAD] Silero VAD initialized (redemption=24 frames = 720ms)
[SERVER] Recording started with Silero VAD
```

### 2. Expected Behavior

**Short utterance (2 seconds)**:
- Speak for 2s → pause 720ms → auto-stops at ~2.7s

**Long utterance (8 seconds)**:
- Speak for 8s → pause 720ms → auto-stops at ~8.7s

**No speech (silence only)**:
- Streams silence for 30s → timeout → stops

### 3. Console Output

You should see:
```
[VAD] Speech START (Silero confidence > 0.8)
[VAD] Speech END (2.3s, silence > 720ms)
[SERVER] VAD stopped recording: silence
[SERVER] Processing 203280 bytes of audio
```

## Troubleshooting

### Problem: VAD never stops
**Cause**: Background noise detected as speech
**Fix**:
- Increase threshold: `POSITIVE_SPEECH_THRESHOLD = 0.9`
- Reduce background noise
- Or use 5-second timer: `USE_VAD=false`

### Problem: Stops too early
**Cause**: Threshold too high, or speaking too quietly
**Fix**:
- Speak closer to mic
- Reduce threshold: `POSITIVE_SPEECH_THRESHOLD = 0.7`
- Increase redemption frames: `REDEMPTION_FRAMES = 33` (1 second) or `40` (1.2 seconds for children)

### Problem: Silero VAD fails to initialize
**Cause**: avr-vad failed to load ONNX model
**Fix**:
- Check `avr-vad` is installed: `npm list avr-vad`
- Reinstall: `npm install avr-vad`
- Use fallback: `USE_VAD=false` in `.env`

## Rollback to 5-Second Timer

If Silero VAD has issues, instantly rollback:

1. Edit `server/.env`:
   ```bash
   USE_VAD=false
   ```

2. Restart server:
   ```bash
   npm run dev
   ```

**Expected behavior:**
- Exactly 5 seconds of recording
- No VAD logs
- Consistent, predictable behavior

## Why Silero VAD?

### Advantages
- ✅ **State-of-the-art**: Deep learning model trained on 6000+ hours of speech
- ✅ **High Accuracy**: 87.7% TPR vs WebRTC VAD's 50% TPR
- ✅ **Production-ready**: Used in commercial voice assistants
- ✅ **No Native Dependencies**: Pure JavaScript/TypeScript
- ✅ **Built-in Resampling**: Handles any sample rate internally
- ✅ **Better Noise Handling**: Robust to background noise and natural pauses

### vs. WebRTC VAD (old)
- ❌ WebRTC VAD: 50% accuracy (energy-based, simple algorithm)
- ❌ WebRTC VAD: Manual resampling required (custom decimation code)
- ❌ WebRTC VAD: Sensitive to background noise
- ❌ WebRTC VAD: Native dependencies (WASM compilation)

## Performance

- **Latency**: ~30ms per frame (negligible)
- **Memory**: ~15MB for ONNX model + runtime
- **CPU**: Minimal (ONNX Runtime optimized for inference)
- **Accuracy**: 87.7% TPR at 5% FPR (significantly better than WebRTC)

## Next Steps After Success

1. **Fine-tune parameters**: Adjust threshold and redemption frames based on environment
2. **Monitor performance**: Log VAD stats over time
3. **Dashboard integration**: Show VAD confidence scores in monitor UI
4. **ESP32-side pre-filtering**: Add simple energy detection to reduce bandwidth (optional)
