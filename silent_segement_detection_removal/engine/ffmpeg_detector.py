"""
FFmpeg Audio Extraction and Silence Detection Engine.
Uses FFmpeg CLI (with silencedetect audio filter) and audio extraction into NumPy arrays.
"""

import os
import re
import shutil
import subprocess
from typing import List, Dict, Any, Tuple, Optional
import numpy as np


class FFmpegDetector:
    """FFmpeg wrapper for extracting audio and detecting silence intervals."""

    def __init__(self, ffmpeg_path: str = "ffmpeg", ffprobe_path: str = "ffprobe"):
        self.ffmpeg_path = shutil.which(ffmpeg_path) or ffmpeg_path
        self.ffprobe_path = shutil.which(ffprobe_path) or ffprobe_path
        self._verify_binaries()

    def _verify_binaries(self):
        try:
            subprocess.run([self.ffmpeg_path, "-version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        except Exception as e:
            raise RuntimeError(f"FFmpeg binary not accessible via '{self.ffmpeg_path}': {e}")

    def get_media_duration(self, media_path: str) -> float:
        """Get duration in seconds of media file using ffprobe or ffmpeg."""
        if not os.path.isfile(media_path):
            raise FileNotFoundError(f"Media file not found: {media_path}")

        # Try ffprobe first
        try:
            cmd = [
                self.ffprobe_path,
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                media_path,
            ]
            result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
            val = result.stdout.strip()
            if val and val != "N/A":
                return float(val)
        except Exception:
            pass

        # Fallback to ffmpeg -i parsing
        cmd = [self.ffmpeg_path, "-i", media_path]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        output = proc.stderr

        match = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)", output)
        if match:
            hours, minutes, seconds = match.groups()
            return int(hours) * 3600 + int(minutes) * 60 + float(seconds)

        raise RuntimeError(f"Could not determine duration for: {media_path}")

    def extract_pcm_16k_mono(
        self,
        media_path: str,
        start_time: Optional[float] = None,
        duration: Optional[float] = None,
    ) -> Tuple[np.ndarray, float]:
        """
        Extract 16kHz mono audio from media file into float32 NumPy array [-1.0, 1.0].
        Returns (audio_array, total_duration_sec).
        """
        if not os.path.isfile(media_path):
            raise FileNotFoundError(f"Media file not found: {media_path}")

        cmd = [self.ffmpeg_path, "-y"]
        if start_time is not None and start_time > 0:
            cmd.extend(["-ss", str(start_time)])

        cmd.extend(["-i", media_path])

        if duration is not None and duration > 0:
            cmd.extend(["-t", str(duration)])

        # Output raw PCM 16-bit signed LE, 1 channel, 16000 Hz to stdout
        cmd.extend(["-vn", "-acodec", "pcm_s16le", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"])

        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
        if proc.returncode != 0:
            raise RuntimeError(f"FFmpeg extraction failed: {proc.stderr.decode('utf-8', errors='ignore')}")

        raw_bytes = proc.stdout
        int16_data = np.frombuffer(raw_bytes, dtype=np.int16)
        float32_data = int16_data.astype(np.float32) / 32768.0
        total_duration = len(float32_data) / 16000.0

        return float32_data, total_duration

    def detect_silence(
        self,
        media_path: str,
        noise_db: float = -35.0,
        min_duration: float = 0.5,
        start_time: Optional[float] = None,
        duration: Optional[float] = None,
        total_media_duration: Optional[float] = None,
    ) -> List[Dict[str, float]]:
        """
        Run FFmpeg silencedetect audio filter.
        noise_db: silence threshold in dB (e.g. -35dB or -30dB).
        min_duration: minimum silence duration in seconds (e.g. 0.5s).
        Returns list of raw silence intervals: [{ "start": float, "end": float, "duration": float }].
        """
        if not os.path.isfile(media_path):
            raise FileNotFoundError(f"Media file not found: {media_path}")

        if total_media_duration is None:
            try:
                total_media_duration = self.get_media_duration(media_path)
            except Exception:
                total_media_duration = None

        cmd = [self.ffmpeg_path, "-nostdin", "-y"]
        if start_time is not None and start_time > 0:
            cmd.extend(["-ss", str(start_time)])

        cmd.extend(["-i", media_path])

        if duration is not None and duration > 0:
            cmd.extend(["-t", str(duration)])

        # silencedetect audio filter
        filter_str = f"silencedetect=noise={noise_db}dB:d={min_duration}"
        cmd.extend(["-af", filter_str, "-f", "null", "-"])

        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, text=True)
        stderr_output = proc.stderr

        return self.parse_silencedetect_output(
            stderr_output,
            total_duration=duration or total_media_duration,
            offset=start_time or 0.0,
        )

    def parse_silencedetect_output(
        self,
        output: str,
        total_duration: Optional[float] = None,
        offset: float = 0.0,
    ) -> List[Dict[str, float]]:
        """
        Parse FFmpeg silencedetect console output.
        Lines look like:
        [silencedetect @ 0000...] silence_start: 5.123
        [silencedetect @ 0000...] silence_end: 8.456 | silence_duration: 3.333
        """
        silence_ranges = []
        current_start = None

        re_start = re.compile(r"silence_start:\s*([0-9\.]+)")
        re_end = re.compile(r"silence_end:\s*([0-9\.]+)(?:\s*\|\s*silence_duration:\s*([0-9\.]+))?")

        for line in output.splitlines():
            m_start = re_start.search(line)
            if m_start:
                current_start = float(m_start.group(1))
                continue

            m_end = re_end.search(line)
            if m_end:
                end_val = float(m_end.group(1))
                if current_start is None:
                    # Silence started at the beginning (0.0)
                    start_val = 0.0
                else:
                    start_val = current_start
                    current_start = None

                dur = round(end_val - start_val, 3)
                if dur > 0.0:
                    silence_ranges.append({
                        "start": round(start_val + offset, 3),
                        "end": round(end_val + offset, 3),
                        "duration": dur,
                    })

        # Handle trailing silence continuing until end of stream
        if current_start is not None and total_duration is not None:
            end_val = total_duration
            if end_val > current_start:
                silence_ranges.append({
                    "start": round(current_start + offset, 3),
                    "end": round(end_val + offset, 3),
                    "duration": round(end_val - current_start, 3),
                })

        return silence_ranges

    def get_sound_timestamps(
        self,
        silence_intervals: List[Dict[str, float]],
        total_duration: float,
        offset: float = 0.0,
    ) -> List[Dict[str, float]]:
        """Compute sound intervals as complement of silence intervals."""
        sound = []
        current = offset

        for item in silence_intervals:
            if item["start"] > current:
                dur = round(item["start"] - current, 3)
                if dur > 0.01:
                    sound.append({
                        "start": round(current, 3),
                        "end": round(item["start"], 3),
                        "duration": dur,
                    })
            current = max(current, item["end"])

        end_limit = offset + total_duration
        if current < end_limit:
            dur = round(end_limit - current, 3)
            if dur > 0.01:
                sound.append({
                    "start": round(current, 3),
                    "end": round(end_limit, 3),
                    "duration": dur,
                })

        return sound
