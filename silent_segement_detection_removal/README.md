# Silent Segment Detection & Removal — Premiere Pro UXP Plugin

An AI-powered Adobe Premiere Pro UXP Plugin and companion engine for intelligent, multi-mode silence and speech detection, interactive preview, and automated Right-to-Left timeline ripple deletion and clip disabling.

---

## Architecture Overview

Based on the architecture specified in [`plan.md`](./plan.md):

```
┌──────────────────────────────────────────────┐
│                    UXP UI                    │
│                                              │
│ • Mode Selection (Fast vs Accurate)          │
│ • Interactive Parameter Controls             │
│ • Multi-Segment Review & Override Table      │
│ • Right-to-Left Execution Engine             │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│          CLIP / SELECTION RESOLVER           │
│                                              │
│ • Active sequence resolution                 │
│ • Source media path & track resolver         │
│ • In/Out boundary mapping                    │
│ • Unsupported clip rejection (speed/reverse) │
└──────────────────────┬───────────────────────┘
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
  ┌────────────────────┐ ┌───────────────────────────┐
  │     FAST MODE      │ │       ACCURATE MODE       │
  │                    │ │                           │
  │ FFmpeg             │ │ FFmpeg + Silero VAD ONNX  │
  │ Silence/Sound      │ │ Silence/Sound + Speech    │
  └──────────┬─────────┘ └─────────────┬─────────────┘
             │                         │
             └────────────┬────────────┘
                          ▼
┌──────────────────────────────────────────────┐
│               RANGE PROCESSOR                │
│                                              │
│ 1. Normalize timestamps                      │
│ 2. Apply Keep Padding (before & after)       │
│ 3. Clamp to clip boundaries                  │
│ 4. Sort ascending                            │
│ 5. Merge nearby/overlapping ranges           │
│ 6. Filter final minimum duration             │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│               DECISION ENGINE                │
│                                              │
│ 🟢 Confirmed Silence  → Cut & Ripple Delete   │
│ 🟡 Disagreement/Noise → Cut & Disable        │
│ ⚪ Active Speech      → Keep                 │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│               SEQUENCE MAPPER                │
│                                              │
│ Source Time → Timeline Time & Frame Snapping │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│                 EDIT PLANNER                 │
│                                              │
│ • Track mapping (linked audio & video)       │
│ • Overlap removal & boundary validation      │
│ • Sort strictly RIGHT → LEFT                 │
└──────────────────────────────────────────────┘
```

---

## 4-Way Decision Matrix (Accurate Mode)

| FFmpeg (Volume) | Silero (Vocal Activity) | Classification | Default Action |
| :--- | :--- | :--- | :--- |
| **SILENCE** | **NO SPEECH** | Strong Silence Confidence | 🟢 **Cut & Ripple Delete** |
| **SILENCE** | **SPEECH** | Whisper / Soft Speech Disagreement | 🟡 **Cut & Disable** |
| **SOUND** | **NO SPEECH** | Music, Keyboard, Ambience, FX | 🟡 **Cut & Disable** |
| **SOUND** | **SPEECH** | Active Human Speech | ⚪ **Keep** |

---

## Installation & Setup

### 1. Requirements
- Adobe Premiere Pro 2024+ (v24.0.0 or later)
- Adobe **UXP Developer Tool (UDT)**
- Python 3.10+ (or Node.js)
- FFmpeg installed and in system `PATH`

### 2. Dependencies
```bash
pip install onnxruntime numpy
```

The ONNX model `silero_vad_16k_op15.onnx` is located in `models/silero_vad_16k_op15.onnx`.

---

## Running the Plugin

### Step 1: Start the Local Companion Server
In the project root directory, run:
```bash
python -m engine.server
```
*The server will start listening on `http://127.0.0.1:38271`.*

### Step 2: Load Plugin in UXP Developer Tool (UDT)
1. Open the **UXP Developer Tool (UDT)**.
2. Click **"Add Plugin..."** and select `plugin/manifest.json`.
3. Click the dropdown menu next to the plugin and choose **"Load"** (or **"Load & Watch"**).
4. In Premiere Pro, open **Window > Extensions / Plugins > Silent Segment Detector**.

---

## CLI Usage (Standalone)

You can analyze any media file directly from the command line:

```bash
# Fast Mode (FFmpeg only)
python -m engine.cli "C:/path/to/media.mp4" --mode fast

# Accurate Mode (FFmpeg + Silero VAD)
python -m engine.cli "C:/path/to/media.mp4" --mode accurate --noise-db -35 --min-silence 0.5

# Save Output as JSON
python -m engine.cli "C:/path/to/media.mp4" --mode accurate --json -o results.json
```

---

## Running Tests

Run the automated test suite covering VAD inference, FFmpeg parsing, range processing, decision matrix, sequence mapping, and right-to-left edit planning:

```bash
python -m unittest discover tests
```
