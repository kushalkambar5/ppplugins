"""
Edit Planner.
Converts mapped timeline ranges with actions into a structured, validated,
and strictly RIGHT -> LEFT sorted Edit Execution Plan for Premiere Pro.
"""

from typing import List, Dict, Any, Optional
from .decision_engine import EditAction


class EditPlanner:
    """
    Builds an abstract timeline edit plan sorted RIGHT -> LEFT to ensure
    safe ripple deletes and track integrity.
    """

    def __init__(
        self,
        video_tracks: Optional[List[int]] = None,
        audio_tracks: Optional[List[int]] = None,
        ripple_all_tracks: bool = True,
    ):
        self.video_tracks = video_tracks if video_tracks is not None else [0]
        self.audio_tracks = audio_tracks if audio_tracks is not None else [0]
        self.ripple_all_tracks = ripple_all_tracks

    def create_plan(
        self,
        mapped_ranges: List[Dict[str, Any]],
        default_video_tracks: Optional[List[int]] = None,
        default_audio_tracks: Optional[List[int]] = None,
    ) -> Dict[str, Any]:
        """
        Generates the final Right-to-Left edit plan.
        Filters out 'KEEP' actions, removes overlaps, and validates.
        """
        v_tracks = default_video_tracks if default_video_tracks is not None else self.video_tracks
        a_tracks = default_audio_tracks if default_audio_tracks is not None else self.audio_tracks

        # 1. Filter out KEEP actions
        active_edits = [
            r for r in mapped_ranges
            if r.get("action") in (EditAction.RIPPLE_DELETE, EditAction.DISABLE, "RIPPLE_DELETE", "DISABLE")
        ]

        if not active_edits:
            return {
                "operations": [],
                "summary": {
                    "total_operations": 0,
                    "ripple_deletes": 0,
                    "disables": 0,
                    "total_time_saved_sec": 0.0,
                    "total_frames_affected": 0,
                }
            }

        # 2. Sort ascending by timeline_start to merge any potential overlaps
        active_edits = sorted(active_edits, key=lambda x: x["timeline_start"])

        # 3. Clean and merge overlapping edit ranges
        clean_edits = []
        for edit in active_edits:
            if not clean_edits:
                clean_edits.append(dict(edit))
                continue

            prev = clean_edits[-1]
            if edit["timeline_start"] <= prev["timeline_end"]:
                # Overlap: extend prev end and inherit stricter action (RIPPLE_DELETE wins over DISABLE)
                prev["timeline_end"] = max(prev["timeline_end"], edit["timeline_end"])
                prev["timeline_duration"] = round(prev["timeline_end"] - prev["timeline_start"], 4)
                if edit.get("action") == EditAction.RIPPLE_DELETE or prev.get("action") == EditAction.RIPPLE_DELETE:
                    prev["action"] = EditAction.RIPPLE_DELETE
                prev["end_frame"] = max(prev.get("end_frame", 0), edit.get("end_frame", 0))
                prev["frame_count"] = prev["end_frame"] - prev.get("start_frame", 0)
                prev["end_ticks"] = max(prev.get("end_ticks", 0), edit.get("end_ticks", 0))
            else:
                clean_edits.append(dict(edit))

        # 4. Sort strictly RIGHT -> LEFT (descending timeline_start)
        # Crucial: Cuts at higher timestamps occur first so earlier timestamps stay valid.
        right_to_left_edits = sorted(clean_edits, key=lambda x: x["timeline_start"], reverse=True)

        operations = []
        total_time_saved = 0.0
        total_frames = 0
        ripple_count = 0
        disable_count = 0

        for idx, item in enumerate(right_to_left_edits, start=1):
            action_val = item.get("action", EditAction.RIPPLE_DELETE)
            dur = item.get("timeline_duration", round(item["timeline_end"] - item["timeline_start"], 4))
            frames = item.get("frame_count", 0)

            if action_val in (EditAction.RIPPLE_DELETE, "RIPPLE_DELETE"):
                ripple_count += 1
                total_time_saved += dur
            elif action_val in (EditAction.DISABLE, "DISABLE"):
                disable_count += 1

            total_frames += frames

            op = {
                "id": f"edit_{idx:03d}",
                "execution_order": idx,
                "action": str(action_val),
                "timeline_start": item["timeline_start"],
                "timeline_end": item["timeline_end"],
                "timeline_duration": dur,
                "timecode_start": item.get("timecode_start", ""),
                "timecode_end": item.get("timecode_end", ""),
                "start_frame": item.get("start_frame", 0),
                "end_frame": item.get("end_frame", 0),
                "frame_count": frames,
                "start_ticks": item.get("start_ticks", 0),
                "end_ticks": item.get("end_ticks", 0),
                "affected_tracks": {
                    "video": v_tracks,
                    "audio": a_tracks,
                },
                "ripple_all_tracks": self.ripple_all_tracks,
                "label": item.get("label", ""),
                "reason": item.get("description", item.get("reason", "")),
                "badge": item.get("badge", "🟢" if action_val == "RIPPLE_DELETE" else "🟡"),
            }
            operations.append(op)

        summary = {
            "total_operations": len(operations),
            "ripple_deletes": ripple_count,
            "disables": disable_count,
            "total_time_saved_sec": round(total_time_saved, 3),
            "total_frames_affected": total_frames,
            "direction": "RIGHT_TO_LEFT",
        }

        return {
            "operations": operations,
            "summary": summary,
        }
