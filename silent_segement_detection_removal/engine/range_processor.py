"""
Range Processor for Silent Segment Detection.
Implements 6-step normalization pipeline:
1. Normalize
2. Apply Padding (Keep Padding)
3. Clamp Boundaries
4. Sort
5. Merge Overlaps & Nearby Ranges
6. Filter Final Short Ranges
"""

from typing import List, Dict, Any, Optional


class RangeProcessor:
    """
    Standardizes and refines raw detected intervals into clean, edit-ready ranges.
    """

    def __init__(
        self,
        keep_before: float = 0.1,
        keep_after: float = 0.1,
        merge_gap: float = 0.2,
        min_final_duration: float = 0.25,
    ):
        self.keep_before = max(0.0, keep_before)
        self.keep_after = max(0.0, keep_after)
        self.merge_gap = max(0.0, merge_gap)
        self.min_final_duration = max(0.01, min_final_duration)

    def process(
        self,
        raw_ranges: List[Dict[str, Any]],
        clip_start: float = 0.0,
        clip_end: Optional[float] = None,
    ) -> List[Dict[str, Any]]:
        """
        Execute full 6-step range refinement pipeline.
        Each item in raw_ranges can contain 'start', 'end', and optional metadata.
        """
        if not raw_ranges:
            return []

        # 1. Normalize
        normalized = self._normalize(raw_ranges)
        if not normalized:
            return []

        # 2. Apply Padding (Keep before / Keep after)
        padded = self._apply_padding(normalized)
        if not padded:
            return []

        # 3. Clamp Boundaries
        clamped = self._clamp_boundaries(padded, clip_start, clip_end)
        if not clamped:
            return []

        # 4. Sort
        sorted_ranges = sorted(clamped, key=lambda r: r["start"])

        # 5. Merge Overlaps and Nearby Ranges
        merged = self._merge_ranges(sorted_ranges, self.merge_gap)

        # 6. Filter Final Short Ranges
        final_ranges = self._filter_min_duration(merged, self.min_final_duration)

        return final_ranges

    def _normalize(self, ranges: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        normalized = []
        for item in ranges:
            start = float(item.get("start", 0.0))
            end = float(item.get("end", 0.0))
            if end > start:
                entry = dict(item)
                entry["start"] = round(start, 4)
                entry["end"] = round(end, 4)
                entry["duration"] = round(end - start, 4)
                normalized.append(entry)
        return normalized

    def _apply_padding(self, ranges: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Keep padding semantics:
        Preserves audio at boundaries by shrinking the silence/cut segment.
        start = start + keep_before
        end = end - keep_after
        """
        padded = []
        for item in ranges:
            start = item["start"] + self.keep_before
            end = item["end"] - self.keep_after
            if (end - start) > 0.001:
                entry = dict(item)
                entry["start"] = round(start, 4)
                entry["end"] = round(end, 4)
                entry["duration"] = round(end - start, 4)
                entry["raw_start"] = item.get("raw_start", item["start"])
                entry["raw_end"] = item.get("raw_end", item["end"])
                padded.append(entry)
        return padded

    def _clamp_boundaries(
        self,
        ranges: List[Dict[str, Any]],
        clip_start: float,
        clip_end: Optional[float],
    ) -> List[Dict[str, Any]]:
        """
        Ensures all edit boundaries stay strictly within valid clip bounds.
        """
        clamped = []
        for item in ranges:
            start = max(clip_start, item["start"])
            end = item["end"]
            if clip_end is not None:
                end = min(clip_end, end)

            if (end - start) > 0.001:
                entry = dict(item)
                entry["start"] = round(start, 4)
                entry["end"] = round(end, 4)
                entry["duration"] = round(end - start, 4)
                clamped.append(entry)
        return clamped

    def _merge_ranges(
        self,
        ranges: List[Dict[str, Any]],
        merge_gap: float,
    ) -> List[Dict[str, Any]]:
        """
        Merges overlapping ranges or ranges separated by <= merge_gap.
        """
        if not ranges:
            return []

        merged = [dict(ranges[0])]

        for current in ranges[1:]:
            prev = merged[-1]
            same_action = prev.get("action") == current.get("action")
            same_state = prev.get("state") == current.get("state")
            # Check overlap or gap (only merge if same action and state)
            if (same_action and same_state) and (current["start"] - prev["end"] <= merge_gap):
                prev["end"] = max(prev["end"], current["end"])
                prev["duration"] = round(prev["end"] - prev["start"], 4)
                # Combine metadata if present
                if "sources" not in prev:
                    prev["sources"] = [prev.get("type", "silence")]
                if "type" in current:
                    prev["sources"].append(current["type"])
            else:
                merged.append(dict(current))

        return merged

    def _filter_min_duration(
        self,
        ranges: List[Dict[str, Any]],
        min_duration: float,
    ) -> List[Dict[str, Any]]:
        """
        Discard ranges whose final duration is shorter than min_duration.
        """
        return [
            r for r in ranges
            if round(r["end"] - r["start"], 4) >= min_duration
        ]
