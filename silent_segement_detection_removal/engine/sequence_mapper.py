"""
Sequence Mapper.
Maps detected source-time intervals into sequence timeline time, converts to frames/ticks,
and validates clip constraints (speed changes, reverse clips, boundary clamping).
"""

from typing import List, Dict, Any, Optional, Tuple


TICKS_PER_SECOND = 254016000000


class ClipValidationError(Exception):
    """Raised when a clip is unsupported (speed ramped, reverse, etc.)."""
    pass


class SequenceMapper:
    """
    Handles translation between Source Media Time and Sequence Timeline Time.
    """

    def __init__(
        self,
        clip_timeline_start: float = 0.0,
        clip_timeline_end: Optional[float] = None,
        source_in_point: float = 0.0,
        source_out_point: Optional[float] = None,
        frame_rate: float = 29.97,
        speed: float = 1.0,
        is_reversed: bool = False,
    ):
        self.clip_timeline_start = max(0.0, float(clip_timeline_start))
        self.clip_timeline_end = float(clip_timeline_end) if clip_timeline_end is not None else None
        self.source_in_point = max(0.0, float(source_in_point))
        self.source_out_point = float(source_out_point) if source_out_point is not None else None
        self.frame_rate = max(1.0, float(frame_rate))
        self.speed = float(speed)
        self.is_reversed = bool(is_reversed)

        self._validate_clip()

    def _validate_clip(self):
        """
        Rejects unsupported clips in V1 per plan.md:
        - Speed changes
        - Reverse clips
        """
        if abs(self.speed - 1.0) > 0.001:
            raise ClipValidationError(
                f"Unsupported clip: Speed is {self.speed}x (must be 1.0x standard speed). Speed-ramped clips are not supported in V1."
            )
        if self.is_reversed:
            raise ClipValidationError(
                "Unsupported clip: Reverse playback clips are not supported in V1."
            )

    def seconds_to_frame(self, seconds: float) -> int:
        """Convert seconds to discrete frame number."""
        return int(round(seconds * self.frame_rate))

    def frame_to_seconds(self, frame: int) -> float:
        """Convert discrete frame number back to precise seconds."""
        return round(frame / self.frame_rate, 6)

    def seconds_to_ticks(self, seconds: float) -> int:
        """Convert seconds to Premiere Pro internal ticks (254,016,000,000 per sec)."""
        return int(round(seconds * TICKS_PER_SECOND))

    def ticks_to_seconds(self, ticks: int) -> float:
        """Convert Premiere Pro internal ticks to seconds."""
        return round(ticks / TICKS_PER_SECOND, 6)

    def snap_to_frame(self, seconds: float) -> float:
        """Snap floating-point seconds to nearest video frame boundary."""
        frame = self.seconds_to_frame(seconds)
        return self.frame_to_seconds(frame)

    def format_timecode(self, seconds: float) -> str:
        """Format seconds as standard HH:MM:SS:FF timecode."""
        total_frames = self.seconds_to_frame(seconds)
        fps = int(round(self.frame_rate))
        ff = total_frames % fps
        total_seconds = total_frames // fps
        ss = total_seconds % 60
        total_minutes = total_seconds // 60
        mm = total_minutes % 60
        hh = total_minutes // 60
        return f"{hh:02d}:{mm:02d}:{ss:02d}:{ff:02d}"

    def source_to_timeline(self, source_time: float) -> float:
        """
        Maps source time to timeline time:
        timelineTime = clipTimelineStart + (sourceTime - sourceInPoint)
        """
        offset = source_time - self.source_in_point
        timeline_time = self.clip_timeline_start + offset
        return round(timeline_time, 6)

    def map_range(self, range_item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Maps a source-time range into timeline time with frame snapping and tick calculations.
        Returns None if range is completely outside clip in/out boundaries.
        """
        src_start = float(range_item["start"])
        src_end = float(range_item["end"])

        # Boundary clamping to source in/out
        if src_end <= self.source_in_point:
            return None
        if self.source_out_point is not None and src_start >= self.source_out_point:
            return None

        effective_src_start = max(src_start, self.source_in_point)
        effective_src_end = src_end
        if self.source_out_point is not None:
            effective_src_end = min(effective_src_end, self.source_out_point)

        if effective_src_end <= effective_src_start:
            return None

        tl_start = self.source_to_timeline(effective_src_start)
        tl_end = self.source_to_timeline(effective_src_end)

        # Snap to frame boundaries
        snapped_tl_start = self.snap_to_frame(tl_start)
        snapped_tl_end = self.snap_to_frame(tl_end)

        if snapped_tl_end <= snapped_tl_start:
            return None

        start_frame = self.seconds_to_frame(snapped_tl_start)
        end_frame = self.seconds_to_frame(snapped_tl_end)
        frame_count = end_frame - start_frame

        mapped = dict(range_item)
        mapped.update({
            "source_start": round(effective_src_start, 4),
            "source_end": round(effective_src_end, 4),
            "source_duration": round(effective_src_end - effective_src_start, 4),
            "timeline_start": snapped_tl_start,
            "timeline_end": snapped_tl_end,
            "timeline_duration": round(snapped_tl_end - snapped_tl_start, 4),
            "start_frame": start_frame,
            "end_frame": end_frame,
            "frame_count": frame_count,
            "start_ticks": self.seconds_to_ticks(snapped_tl_start),
            "end_ticks": self.seconds_to_ticks(snapped_tl_end),
            "timecode_start": self.format_timecode(snapped_tl_start),
            "timecode_end": self.format_timecode(snapped_tl_end),
        })

        return mapped

    def map_ranges(self, ranges: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Map a collection of source-time ranges to timeline time."""
        mapped_list = []
        for r in ranges:
            mapped = self.map_range(r)
            if mapped is not None:
                mapped_list.append(mapped)
        return mapped_list
