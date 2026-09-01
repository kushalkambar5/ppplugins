"""
Silent Segment Detection & Removal Engine Package.
"""

from .silence_detector import SilenceDetectorPipeline
from .decision_engine import DecisionEngine, EditAction, AudioState
from .range_processor import RangeProcessor
from .sequence_mapper import SequenceMapper, ClipValidationError
from .edit_planner import EditPlanner
from .vad_onnx import SileroVAD
from .ffmpeg_detector import FFmpegDetector

__all__ = [
    "SilenceDetectorPipeline",
    "DecisionEngine",
    "EditAction",
    "AudioState",
    "RangeProcessor",
    "SequenceMapper",
    "ClipValidationError",
    "EditPlanner",
    "SileroVAD",
    "FFmpegDetector",
]
