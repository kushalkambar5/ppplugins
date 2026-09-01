"""
Comprehensive Unit Test Suite for Silent Segment Detection & Removal Engine.
"""

import os
import unittest
import numpy as np

from engine.vad_onnx import SileroVAD
from engine.ffmpeg_detector import FFmpegDetector
from engine.range_processor import RangeProcessor
from engine.decision_engine import DecisionEngine, EditAction, AudioState
from engine.sequence_mapper import SequenceMapper, ClipValidationError, TICKS_PER_SECOND
from engine.edit_planner import EditPlanner


class TestSileroVAD(unittest.TestCase):
    def setUp(self):
        model_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models", "silero_vad_16k_op15.onnx")
        self.vad = SileroVAD(model_path=model_path)

    def test_silence_chunk(self):
        # 512 zeros should yield near 0.0 speech probability
        chunk = np.zeros(512, dtype=np.float32)
        prob = self.vad.process_chunk(chunk)
        self.assertIsInstance(prob, float)
        self.assertLess(prob, 0.2)

    def test_speech_timestamps_synthetic(self):
        # 16000 samples = 1 sec of zeros
        silence = np.zeros(16000, dtype=np.float32)
        timestamps = self.vad.get_speech_timestamps(silence, threshold=0.5)
        self.assertEqual(len(timestamps), 0)

    def test_non_speech_timestamps(self):
        silence = np.zeros(16000, dtype=np.float32)
        non_speech = self.vad.get_non_speech_timestamps(silence, total_duration_sec=1.0)
        self.assertGreaterEqual(len(non_speech), 1)
        self.assertEqual(non_speech[0]["start"], 0.0)


class TestFFmpegDetector(unittest.TestCase):
    def test_parse_silencedetect_output(self):
        detector = FFmpegDetector()
        mock_output = """
[silencedetect @ 0000021c3b] silence_start: 5.12
[silencedetect @ 0000021c3b] silence_end: 8.45 | silence_duration: 3.33
[silencedetect @ 0000021c3b] silence_start: 20.00
[silencedetect @ 0000021c3b] silence_end: 25.50 | silence_duration: 5.50
        """
        ranges = detector.parse_silencedetect_output(mock_output)
        self.assertEqual(len(ranges), 2)
        self.assertEqual(ranges[0]["start"], 5.12)
        self.assertEqual(ranges[0]["end"], 8.45)
        self.assertEqual(ranges[0]["duration"], 3.33)
        self.assertEqual(ranges[1]["start"], 20.0)
        self.assertEqual(ranges[1]["end"], 25.5)

    def test_parse_trailing_silence(self):
        detector = FFmpegDetector()
        mock_output = """
[silencedetect @ 0000021c3b] silence_start: 10.00
        """
        ranges = detector.parse_silencedetect_output(mock_output, total_duration=15.0)
        self.assertEqual(len(ranges), 1)
        self.assertEqual(ranges[0]["start"], 10.0)
        self.assertEqual(ranges[0]["end"], 15.0)


class TestRangeProcessor(unittest.TestCase):
    def test_padding_and_clamping(self):
        # Raw silence: 5.0 -> 8.0
        # keep_before = 0.1, keep_after = 0.1
        # Result should be 5.1 -> 7.9
        processor = RangeProcessor(keep_before=0.1, keep_after=0.1, merge_gap=0.2, min_final_duration=0.2)
        raw = [{"start": 5.0, "end": 8.0}]
        res = processor.process(raw, clip_start=0.0, clip_end=10.0)
        self.assertEqual(len(res), 1)
        self.assertAlmostEqual(res[0]["start"], 5.1, places=2)
        self.assertAlmostEqual(res[0]["end"], 7.9, places=2)

    def test_merging_close_ranges(self):
        # Two ranges with gap 0.15s (<= merge_gap of 0.2s)
        # Range 1: 2.0 -> 4.0
        # Range 2: 4.15 -> 6.0
        # Should be merged into one range
        processor = RangeProcessor(keep_before=0.0, keep_after=0.0, merge_gap=0.2, min_final_duration=0.2)
        raw = [
            {"start": 2.0, "end": 4.0},
            {"start": 4.15, "end": 6.0},
        ]
        res = processor.process(raw, clip_start=0.0, clip_end=10.0)
        self.assertEqual(len(res), 1)
        self.assertAlmostEqual(res[0]["start"], 2.0, places=2)
        self.assertAlmostEqual(res[0]["end"], 6.0, places=2)

    def test_filter_short_ranges(self):
        # Range of duration 0.1s when min_final_duration is 0.25s should be dropped
        processor = RangeProcessor(keep_before=0.0, keep_after=0.0, min_final_duration=0.25)
        raw = [{"start": 1.0, "end": 1.1}]
        res = processor.process(raw, clip_start=0.0, clip_end=10.0)
        self.assertEqual(len(res), 0)


class TestDecisionEngine(unittest.TestCase):
    def test_accurate_mode_matrix(self):
        # 1. Silence + No Speech -> RIPPLE_DELETE
        c1 = DecisionEngine.classify_accurate_mode(is_ffmpeg_silent=True, is_silero_speech=False)
        self.assertEqual(c1["action"], EditAction.RIPPLE_DELETE)
        self.assertEqual(c1["state"], AudioState.CONFIRMED_SILENCE)

        # 2. Silence + Speech -> DISABLE
        c2 = DecisionEngine.classify_accurate_mode(is_ffmpeg_silent=True, is_silero_speech=True)
        self.assertEqual(c2["action"], EditAction.DISABLE)
        self.assertEqual(c2["state"], AudioState.QUIET_SPEECH)

        # 3. Sound + No Speech -> DISABLE
        c3 = DecisionEngine.classify_accurate_mode(is_ffmpeg_silent=False, is_silero_speech=False)
        self.assertEqual(c3["action"], EditAction.DISABLE)
        self.assertEqual(c3["state"], AudioState.NON_SPEECH_SOUND)

        # 4. Sound + Speech -> KEEP
        c4 = DecisionEngine.classify_accurate_mode(is_ffmpeg_silent=False, is_silero_speech=True)
        self.assertEqual(c4["action"], EditAction.KEEP)
        self.assertEqual(c4["state"], AudioState.ACTIVE_SPEECH)

    def test_partition_timeline(self):
        # Total duration 10s
        # Silence: 2s -> 5s
        # Speech: 4s -> 8s
        # Partitions:
        # [0, 2]: Sound + No Speech -> DISABLE
        # [2, 4]: Silence + No Speech -> RIPPLE_DELETE
        # [4, 5]: Silence + Speech -> DISABLE
        # [5, 8]: Sound + Speech -> KEEP
        # [8, 10]: Sound + No Speech -> DISABLE
        ffmpeg_silence = [{"start": 2.0, "end": 5.0}]
        silero_speech = [{"start": 4.0, "end": 8.0}]

        segments = DecisionEngine.partition_and_evaluate(
            total_duration=10.0,
            ffmpeg_silence_ranges=ffmpeg_silence,
            silero_speech_ranges=silero_speech,
            is_fast_mode=False,
        )
        self.assertEqual(len(segments), 5)
        self.assertEqual(segments[0]["action"], EditAction.DISABLE)
        self.assertEqual(segments[1]["action"], EditAction.RIPPLE_DELETE)
        self.assertEqual(segments[2]["action"], EditAction.DISABLE)
        self.assertEqual(segments[3]["action"], EditAction.KEEP)
        self.assertEqual(segments[4]["action"], EditAction.DISABLE)


class TestSequenceMapper(unittest.TestCase):
    def test_mapping_with_in_point_and_offset(self):
        # Clip starts at timeline 100.0s, source in_point is 10.0s
        # Source silence is 15.0s -> 18.0s (offset +5s -> +8s from in_point)
        # Expected timeline range: 105.0s -> 108.0s
        mapper = SequenceMapper(
            clip_timeline_start=100.0,
            source_in_point=10.0,
            source_out_point=60.0,
            frame_rate=30.0,
        )
        item = {"start": 15.0, "end": 18.0, "action": EditAction.RIPPLE_DELETE}
        mapped = mapper.map_range(item)
        self.assertIsNotNone(mapped)
        self.assertAlmostEqual(mapped["timeline_start"], 105.0, places=2)
        self.assertAlmostEqual(mapped["timeline_end"], 108.0, places=2)
        self.assertEqual(mapped["start_ticks"], int(105.0 * TICKS_PER_SECOND))

    def test_frame_snapping(self):
        mapper = SequenceMapper(frame_rate=25.0)
        # 1.02 sec at 25 fps -> 25.5 frames -> snaps to 26 frames = 1.04 sec
        snapped = mapper.snap_to_frame(1.02)
        self.assertAlmostEqual(snapped, 1.04, places=2)

    def test_speed_rejection(self):
        with self.assertRaises(ClipValidationError):
            SequenceMapper(speed=1.5)


class TestEditPlanner(unittest.TestCase):
    def test_right_to_left_sorting(self):
        # Given ranges at 10s, 30s, 50s
        # EditPlanner should output order: 50s first, then 30s, then 10s
        planner = EditPlanner(video_tracks=[0], audio_tracks=[0, 1])
        ranges = [
            {"timeline_start": 10.0, "timeline_end": 15.0, "action": EditAction.RIPPLE_DELETE},
            {"timeline_start": 50.0, "timeline_end": 55.0, "action": EditAction.RIPPLE_DELETE},
            {"timeline_start": 30.0, "timeline_end": 35.0, "action": EditAction.DISABLE},
            {"timeline_start": 70.0, "timeline_end": 80.0, "action": EditAction.KEEP},  # should be ignored
        ]
        plan = planner.create_plan(ranges)
        ops = plan["operations"]
        self.assertEqual(len(ops), 3)
        self.assertEqual(ops[0]["timeline_start"], 50.0)
        self.assertEqual(ops[1]["timeline_start"], 30.0)
        self.assertEqual(ops[2]["timeline_start"], 10.0)
        self.assertEqual(plan["summary"]["ripple_deletes"], 2)
        self.assertEqual(plan["summary"]["disables"], 1)


if __name__ == "__main__":
    unittest.main()
