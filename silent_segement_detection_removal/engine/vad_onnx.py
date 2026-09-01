"""
Silero VAD v5 ONNX Inference Engine
Streaming chunk-by-chunk and batch processing for speech / no-speech detection.
"""

import os
from typing import List, Dict, Any, Tuple, Optional
import numpy as np
import onnxruntime as ort


class SileroVAD:
    """Silero VAD ONNX wrapper supporting 16kHz mono audio."""

    def __init__(self, model_path: Optional[str] = None):
        if model_path is None:
            # Look in models directory relative to project root
            base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            model_path = os.path.join(base_dir, "models", "silero_vad_16k_op15.onnx")

        if not os.path.isfile(model_path):
            raise FileNotFoundError(f"Silero VAD model not found at: {model_path}")

        self.model_path = model_path
        # Setup ONNX session options
        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 2
        opts.log_severity_level = 3  # Warning/Error only

        self.session = ort.InferenceSession(self.model_path, sess_options=opts, providers=["CPUExecutionProvider"])
        self.sample_rate = 16000
        self.chunk_size = 512  # 32ms at 16kHz
        self._reset_state()

    def _reset_state(self, batch_size: int = 1):
        self._state = np.zeros((2, batch_size, 128), dtype=np.float32)

    def process_chunk(self, chunk: np.ndarray) -> float:
        """
        Process a single 512-sample float32 chunk at 16kHz.
        Returns speech probability [0.0, 1.0].
        """
        if len(chunk) < self.chunk_size:
            chunk = np.pad(chunk, (0, self.chunk_size - len(chunk)), mode="constant")
        elif len(chunk) > self.chunk_size:
            chunk = chunk[: self.chunk_size]

        # Ensure float32 and shape (1, 512)
        input_tensor = np.asarray(chunk, dtype=np.float32).reshape(1, -1)
        sr_tensor = np.array(self.sample_rate, dtype=np.int64)

        ort_inputs = {
            "input": input_tensor,
            "state": self._state,
            "sr": sr_tensor,
        }

        ort_outs = self.session.run(None, ort_inputs)
        # ort_outs[0]: output probability (1, 1)
        # ort_outs[1]: updated state (2, 1, 128)
        prob = float(ort_outs[0][0][0])
        self._state = ort_outs[1]
        return prob

    def get_speech_probabilities(self, audio: np.ndarray) -> List[Dict[str, Any]]:
        """
        Process full 16kHz mono audio array.
        Returns list of { "time": float, "prob": float, "is_speech": bool } for each 32ms chunk.
        """
        self._reset_state()
        num_samples = len(audio)
        results = []

        chunk_duration = self.chunk_size / self.sample_rate  # 0.032 seconds

        for idx in range(0, num_samples, self.chunk_size):
            chunk = audio[idx : idx + self.chunk_size]
            current_time = idx / self.sample_rate
            prob = self.process_chunk(chunk)
            results.append({
                "time": round(current_time, 4),
                "duration": round(chunk_duration, 4),
                "prob": round(prob, 4),
            })

        return results

    def get_speech_timestamps(
        self,
        audio: np.ndarray,
        threshold: float = 0.5,
        neg_threshold: Optional[float] = None,
        min_speech_duration_ms: int = 250,
        min_silence_duration_ms: int = 100,
        speech_pad_ms: int = 30,
        return_seconds: bool = True,
    ) -> List[Dict[str, float]]:
        """
        Detect speech segments from audio using Silero VAD hysteresis logic.
        Returns list of speech intervals: [{ "start": float, "end": float, "prob": float }].
        """
        if neg_threshold is None:
            neg_threshold = max(0.15, threshold - 0.15)

        self._reset_state()
        min_speech_samples = int(self.sample_rate * min_speech_duration_ms / 1000)
        min_silence_samples = int(self.sample_rate * min_silence_duration_ms / 1000)
        speech_pad_samples = int(self.sample_rate * speech_pad_ms / 1000)

        audio_length_samples = len(audio)
        speech_probs = []

        for idx in range(0, audio_length_samples, self.chunk_size):
            chunk = audio[idx : idx + self.chunk_size]
            prob = self.process_chunk(chunk)
            speech_probs.append(prob)

        triggered = False
        speeches = []
        current_speech = {}
        temp_end = 0

        for i, prob in enumerate(speech_probs):
            current_sample = i * self.chunk_size

            if prob >= threshold and temp_end:
                temp_end = 0

            if prob >= threshold and not triggered:
                triggered = True
                current_speech["start"] = current_sample
                current_speech["max_prob"] = prob
                current_speech["prob_sum"] = prob
                current_speech["count"] = 1
                continue

            if triggered:
                current_speech["max_prob"] = max(current_speech.get("max_prob", prob), prob)
                current_speech["prob_sum"] = current_speech.get("prob_sum", 0.0) + prob
                current_speech["count"] = current_speech.get("count", 0) + 1

            if prob < neg_threshold and triggered:
                if not temp_end:
                    temp_end = current_sample
                if current_sample - temp_end >= min_silence_samples:
                    current_speech["end"] = temp_end
                    if (current_speech["end"] - current_speech["start"]) >= min_speech_samples:
                        speeches.append(current_speech)
                    current_speech = {}
                    temp_end = 0
                    triggered = False

        if triggered and (audio_length_samples - current_speech["start"]) >= min_speech_samples:
            current_speech["end"] = audio_length_samples
            speeches.append(current_speech)

        # Apply padding and convert to seconds if requested
        result = []
        for i, speech in enumerate(speeches):
            start = max(0, speech["start"] - speech_pad_samples)
            end = min(audio_length_samples, speech["end"] + speech_pad_samples)
            if i > 0 and start < result[-1]["end"]:
                # Merge overlapping padded segments
                result[-1]["end"] = end
                continue

            avg_prob = round(speech["prob_sum"] / max(1, speech["count"]), 3)

            if return_seconds:
                result.append({
                    "start": round(start / self.sample_rate, 3),
                    "end": round(end / self.sample_rate, 3),
                    "duration": round((end - start) / self.sample_rate, 3),
                    "avg_prob": avg_prob,
                    "max_prob": round(speech.get("max_prob", avg_prob), 3),
                })
            else:
                result.append({
                    "start": start,
                    "end": end,
                    "duration": end - start,
                    "avg_prob": avg_prob,
                    "max_prob": round(speech.get("max_prob", avg_prob), 3),
                })

        return result

    def get_non_speech_timestamps(
        self,
        audio: np.ndarray,
        total_duration_sec: float,
        threshold: float = 0.5,
        min_speech_duration_ms: int = 250,
        min_silence_duration_ms: int = 100,
    ) -> List[Dict[str, float]]:
        """
        Get non-speech intervals (complement of speech intervals).
        """
        speech_intervals = self.get_speech_timestamps(
            audio,
            threshold=threshold,
            min_speech_duration_ms=min_speech_duration_ms,
            min_silence_duration_ms=min_silence_duration_ms,
        )

        non_speech = []
        current_time = 0.0

        for interval in speech_intervals:
            if interval["start"] > current_time:
                dur = round(interval["start"] - current_time, 3)
                if dur > 0.01:
                    non_speech.append({
                        "start": round(current_time, 3),
                        "end": round(interval["start"], 3),
                        "duration": dur,
                        "is_speech": False,
                    })
            current_time = max(current_time, interval["end"])

        if current_time < total_duration_sec:
            dur = round(total_duration_sec - current_time, 3)
            if dur > 0.01:
                non_speech.append({
                    "start": round(current_time, 3),
                    "end": round(total_duration_sec, 3),
                    "duration": dur,
                    "is_speech": False,
                })

        return non_speech
