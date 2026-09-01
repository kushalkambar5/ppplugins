"""
Decision Engine for Silent Segment Detection.
Implements the 4-way classification matrix between FFmpeg (Silence/Sound)
and Silero VAD (Speech/No Speech).
"""

from enum import Enum
from typing import List, Dict, Any, Optional


class EditAction(str, Enum):
    RIPPLE_DELETE = "RIPPLE_DELETE"  # 🟢 Cut & Ripple Delete
    DISABLE = "DISABLE"              # 🟡 Cut & Disable
    KEEP = "KEEP"                    # ⚪ Keep


class AudioState(str, Enum):
    CONFIRMED_SILENCE = "CONFIRMED_SILENCE"      # FFmpeg SILENCE + Silero NO_SPEECH
    QUIET_SPEECH = "QUIET_SPEECH"                # FFmpeg SILENCE + Silero SPEECH
    NON_SPEECH_SOUND = "NON_SPEECH_SOUND"        # FFmpeg SOUND + Silero NO_SPEECH
    ACTIVE_SPEECH = "ACTIVE_SPEECH"              # FFmpeg SOUND + Silero SPEECH


class DecisionEngine:
    """
    Evaluates audio segments using FFmpeg volume detection and Silero VAD speech detection.
    """

    @staticmethod
    def classify_accurate_mode(is_ffmpeg_silent: bool, is_silero_speech: bool) -> Dict[str, Any]:
        """
        Determines the state and default action based on the 4-way decision matrix.
        """
        if is_ffmpeg_silent and not is_silero_speech:
            return {
                "state": AudioState.CONFIRMED_SILENCE,
                "action": EditAction.RIPPLE_DELETE,
                "badge": "🟢",
                "color": "green",
                "label": "Confirmed Silence",
                "ffmpeg_status": "SILENCE",
                "silero_status": "NO SPEECH",
                "description": "Strong silence confidence (quiet and no speech)",
            }
        elif is_ffmpeg_silent and is_silero_speech:
            return {
                "state": AudioState.QUIET_SPEECH,
                "action": EditAction.DISABLE,
                "badge": "🟡",
                "color": "yellow",
                "label": "Quiet/Soft Speech",
                "ffmpeg_status": "SILENCE",
                "silero_status": "SPEECH",
                "description": "Detector disagreement (quiet whisper or soft speech)",
            }
        elif not is_ffmpeg_silent and not is_silero_speech:
            return {
                "state": AudioState.NON_SPEECH_SOUND,
                "action": EditAction.DISABLE,
                "badge": "🟡",
                "color": "yellow",
                "label": "Non-Speech Audio",
                "ffmpeg_status": "SOUND",
                "silero_status": "NO SPEECH",
                "description": "Audible sound without human voice (music, noise, typing, ambient)",
            }
        else:
            return {
                "state": AudioState.ACTIVE_SPEECH,
                "action": EditAction.KEEP,
                "badge": "⚪",
                "color": "gray",
                "label": "Active Speech",
                "ffmpeg_status": "SOUND",
                "silero_status": "SPEECH",
                "description": "Clear active human speech",
            }

    @staticmethod
    def classify_fast_mode(is_ffmpeg_silent: bool) -> Dict[str, Any]:
        """
        Fast mode classification (FFmpeg only).
        """
        if is_ffmpeg_silent:
            return {
                "state": "SILENCE",
                "action": EditAction.RIPPLE_DELETE,
                "badge": "🟢",
                "color": "green",
                "label": "Silence (Fast)",
                "ffmpeg_status": "SILENCE",
                "silero_status": "N/A",
                "description": "Detected silence below volume threshold",
            }
        else:
            return {
                "state": "SOUND",
                "action": EditAction.KEEP,
                "badge": "⚪",
                "color": "gray",
                "label": "Sound",
                "ffmpeg_status": "SOUND",
                "silero_status": "N/A",
                "description": "Audible sound",
            }

    @classmethod
    def partition_and_evaluate(
        cls,
        total_duration: float,
        ffmpeg_silence_ranges: List[Dict[str, float]],
        silero_speech_ranges: Optional[List[Dict[str, float]]] = None,
        is_fast_mode: bool = False,
    ) -> List[Dict[str, Any]]:
        """
        Partitions the timeline [0, total_duration] into contiguous non-overlapping
        intervals with constant FFmpeg and Silero states, and evaluates each.
        """
        # Collect all boundary points
        points = {0.0, round(total_duration, 4)}

        for r in ffmpeg_silence_ranges:
            points.add(round(max(0.0, r["start"]), 4))
            points.add(round(min(total_duration, r["end"]), 4))

        if not is_fast_mode and silero_speech_ranges:
            for r in silero_speech_ranges:
                points.add(round(max(0.0, r["start"]), 4))
                points.add(round(min(total_duration, r["end"]), 4))

        sorted_points = sorted(list(points))
        evaluated_segments = []

        for i in range(len(sorted_points) - 1):
            t_start = sorted_points[i]
            t_end = sorted_points[i + 1]
            dur = round(t_end - t_start, 4)
            if dur < 0.005:
                continue

            midpoint = (t_start + t_end) / 2.0

            # Check FFmpeg state at midpoint
            is_silent = any(r["start"] <= midpoint <= r["end"] for r in ffmpeg_silence_ranges)

            if is_fast_mode:
                eval_info = cls.classify_fast_mode(is_silent)
            else:
                is_speech = False
                if silero_speech_ranges:
                    is_speech = any(r["start"] <= midpoint <= r["end"] for r in silero_speech_ranges)
                eval_info = cls.classify_accurate_mode(is_silent, is_speech)

            entry = {
                "start": t_start,
                "end": t_end,
                "duration": dur,
                **eval_info,
            }
            evaluated_segments.append(entry)

        # Merge adjacent segments with identical state and action
        merged = []
        for seg in evaluated_segments:
            if not merged:
                merged.append(seg)
                continue

            prev = merged[-1]
            if prev["state"] == seg["state"] and prev["action"] == seg["action"]:
                prev["end"] = seg["end"]
                prev["duration"] = round(prev["end"] - prev["start"], 4)
            else:
                merged.append(seg)

        return merged
