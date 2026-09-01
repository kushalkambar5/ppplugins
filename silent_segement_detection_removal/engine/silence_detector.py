"""
Main Silence Detection Pipeline Orchestrator.
Coordinates:
- FFmpeg Silence Detector
- Silero VAD ONNX Engine
- Range Processor
- Decision Engine
- Sequence Mapper
- Edit Planner
"""

import os
import time
from typing import List, Dict, Any, Optional, Callable

from .ffmpeg_detector import FFmpegDetector
from .vad_onnx import SileroVAD
from .range_processor import RangeProcessor
from .decision_engine import DecisionEngine, EditAction
from .sequence_mapper import SequenceMapper
from .edit_planner import EditPlanner


class SilenceDetectorPipeline:
    """
    Complete end-to-end pipeline for Fast and Accurate silence & speech detection.
    """

    def __init__(
        self,
        model_path: Optional[str] = None,
        ffmpeg_path: str = "ffmpeg",
        ffprobe_path: str = "ffprobe",
    ):
        self.ffmpeg = FFmpegDetector(ffmpeg_path=ffmpeg_path, ffprobe_path=ffprobe_path)
        if model_path is None:
            base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            model_path = os.path.join(base_dir, "models", "silero_vad_16k_op15.onnx")
        self.model_path = model_path
        self._vad = None  # Lazy load

    def _get_vad(self) -> SileroVAD:
        if self._vad is None:
            self._vad = SileroVAD(model_path=self.model_path)
        return self._vad

    def analyze(
        self,
        media_path: str,
        mode: str = "accurate",  # "fast" or "accurate"
        clip_info: Optional[Dict[str, Any]] = None,
        settings: Optional[Dict[str, Any]] = None,
        progress_cb: Optional[Callable[[float, str], None]] = None,
    ) -> Dict[str, Any]:
        """
        Execute full detection pipeline.
        clip_info: optional dict containing:
          - clip_timeline_start (sec)
          - clip_timeline_end (sec)
          - source_in_point (sec)
          - source_out_point (sec)
          - frame_rate (fps)
          - speed (float)
          - is_reversed (bool)
        settings: optional dict containing:
          - noise_db (float, default -35.0)
          - min_silence_duration (float, default 0.5)
          - speech_threshold (float, default 0.5)
          - keep_before (float, default 0.1)
          - keep_after (float, default 0.1)
          - merge_gap (float, default 0.2)
          - min_final_duration (float, default 0.25)
        """
        start_time_proc = time.time()
        settings = settings or {}

        noise_db = float(settings.get("noise_db", -35.0))
        min_silence_dur = float(settings.get("min_silence_duration", 0.5))
        speech_thresh = float(settings.get("speech_threshold", 0.5))
        keep_before = float(settings.get("keep_before", 0.1))
        keep_after = float(settings.get("keep_after", 0.1))
        merge_gap = float(settings.get("merge_gap", 0.2))
        min_final_dur = float(settings.get("min_final_duration", 0.25))

        if progress_cb:
            progress_cb(0.05, "Inspecting media metadata...")

        # 1. Get media duration and source bounds
        total_media_duration = self.ffmpeg.get_media_duration(media_path)
        source_in = float(clip_info.get("source_in_point", 0.0)) if clip_info else 0.0
        source_out = float(clip_info.get("source_out_point", total_media_duration)) if clip_info else total_media_duration
        clip_duration = max(0.1, source_out - source_in)

        # 2. Run FFmpeg silencedetect
        if progress_cb:
            progress_cb(0.15, f"Running FFmpeg silence detector ({noise_db} dB, min {min_silence_dur}s)...")

        ffmpeg_silence = self.ffmpeg.detect_silence(
            media_path=media_path,
            noise_db=noise_db,
            min_duration=min_silence_dur,
            start_time=source_in,
            duration=clip_duration,
            total_media_duration=total_media_duration,
        )

        silero_speech = None

        # 3. Run Silero VAD if Accurate Mode
        if mode.lower() == "accurate":
            if progress_cb:
                progress_cb(0.35, "Extracting audio for Silero neural VAD...")

            audio_data, audio_dur = self.ffmpeg.extract_pcm_16k_mono(
                media_path=media_path,
                start_time=source_in,
                duration=clip_duration,
            )

            if progress_cb:
                progress_cb(0.55, "Running Silero neural voice activity model...")

            vad = self._get_vad()
            raw_speech = vad.get_speech_timestamps(
                audio=audio_data,
                threshold=speech_thresh,
                min_speech_duration_ms=250,
                min_silence_duration_ms=100,
                speech_pad_ms=30,
            )

            # Offset speech ranges to match source_in
            silero_speech = []
            for s in raw_speech:
                silero_speech.append({
                    "start": round(s["start"] + source_in, 3),
                    "end": round(s["end"] + source_in, 3),
                    "duration": s["duration"],
                    "avg_prob": s["avg_prob"],
                    "max_prob": s["max_prob"],
                })

        # 4. Decision Engine: Partition & Classify
        if progress_cb:
            progress_cb(0.75, "Evaluating decision matrix and classifying audio...")

        raw_segments = DecisionEngine.partition_and_evaluate(
            total_duration=source_out,
            ffmpeg_silence_ranges=ffmpeg_silence,
            silero_speech_ranges=silero_speech,
            is_fast_mode=(mode.lower() == "fast"),
        )

        # 5. Range Processor: Apply Padding, Clamp, Merge, Filter
        if progress_cb:
            progress_cb(0.85, "Refining edit ranges (padding, clamp, merge)...")

        processor = RangeProcessor(
            keep_before=keep_before,
            keep_after=keep_after,
            merge_gap=merge_gap,
            min_final_duration=min_final_dur,
        )

        # We process ranges that require an edit (non-KEEP)
        action_segments = [s for s in raw_segments if s["action"] != EditAction.KEEP]
        keep_segments = [s for s in raw_segments if s["action"] == EditAction.KEEP]

        processed_action_segments = processor.process(
            raw_ranges=action_segments,
            clip_start=source_in,
            clip_end=source_out,
        )

        # Combine processed action segments with keep segments
        all_segments = sorted(
            processed_action_segments + keep_segments,
            key=lambda x: x["start"]
        )

        # 6. Sequence Mapper (if clip_info provided)
        if clip_info:
            if progress_cb:
                progress_cb(0.92, "Mapping timestamps to sequence frames and ticks...")

            mapper = SequenceMapper(
                clip_timeline_start=clip_info.get("clip_timeline_start", 0.0),
                clip_timeline_end=clip_info.get("clip_timeline_end"),
                source_in_point=source_in,
                source_out_point=source_out,
                frame_rate=clip_info.get("frame_rate", 29.97),
                speed=clip_info.get("speed", 1.0),
                is_reversed=clip_info.get("is_reversed", False),
            )
            all_segments = mapper.map_ranges(all_segments)

        elapsed = round(time.time() - start_time_proc, 2)
        if progress_cb:
            progress_cb(1.0, f"Analysis complete in {elapsed}s.")

        # Compute summary stats
        ripple_count = sum(1 for s in all_segments if s.get("action") == EditAction.RIPPLE_DELETE)
        disable_count = sum(1 for s in all_segments if s.get("action") == EditAction.DISABLE)
        keep_count = sum(1 for s in all_segments if s.get("action") == EditAction.KEEP)
        silence_dur = sum(s["duration"] for s in all_segments if s.get("action") == EditAction.RIPPLE_DELETE)

        return {
            "mode": mode,
            "media_path": media_path,
            "clip_source_duration": round(clip_duration, 3),
            "total_media_duration": round(total_media_duration, 3),
            "processing_time_sec": elapsed,
            "segments": all_segments,
            "summary": {
                "total_segments": len(all_segments),
                "ripple_delete_count": ripple_count,
                "disable_count": disable_count,
                "keep_count": keep_count,
                "detected_silence_duration_sec": round(silence_dur, 3),
                "potential_time_saved_percent": round((silence_dur / max(0.01, clip_duration)) * 100, 1),
            },
            "settings": {
                "noise_db": noise_db,
                "min_silence_duration": min_silence_dur,
                "speech_threshold": speech_thresh,
                "keep_before": keep_before,
                "keep_after": keep_after,
                "merge_gap": merge_gap,
                "min_final_duration": min_final_dur,
            }
        }

    def plan_edits(
        self,
        analyzed_segments: List[Dict[str, Any]],
        video_tracks: Optional[List[int]] = None,
        audio_tracks: Optional[List[int]] = None,
        ripple_all_tracks: bool = True,
    ) -> Dict[str, Any]:
        """
        Converts preview segments (with user overrides) into a Right-to-Left edit plan.
        """
        planner = EditPlanner(
            video_tracks=video_tracks,
            audio_tracks=audio_tracks,
            ripple_all_tracks=ripple_all_tracks,
        )
        return planner.create_plan(analyzed_segments)
