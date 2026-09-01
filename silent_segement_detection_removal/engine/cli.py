"""
Command-Line Interface for Silent Segment Detection & Removal.
Allows running detection, previewing segments, and generating edit plans directly from terminal.
"""

import argparse
import json
import os
import sys

# Ensure UTF-8 stdout on Windows console
if sys.platform == "win32" and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

from .silence_detector import SilenceDetectorPipeline


def main():
    parser = argparse.ArgumentParser(
        description="Silent Segment Detection & Removal Engine for Adobe Premiere Pro"
    )
    parser.add_argument("media_path", help="Path to input audio/video media file")
    parser.add_argument(
        "--mode",
        choices=["fast", "accurate"],
        default="accurate",
        help="Detection mode: fast (FFmpeg only) or accurate (FFmpeg + Silero VAD)",
    )
    parser.add_argument("--noise-db", type=float, default=-35.0, help="Silence noise threshold in dB (default: -35.0)")
    parser.add_argument("--min-silence", type=float, default=0.5, help="Minimum silence duration in sec (default: 0.5)")
    parser.add_argument("--speech-threshold", type=float, default=0.5, help="Silero speech probability threshold (default: 0.5)")
    parser.add_argument("--keep-before", type=float, default=0.1, help="Keep padding before silence in sec (default: 0.1)")
    parser.add_argument("--keep-after", type=float, default=0.1, help="Keep padding after silence in sec (default: 0.1)")
    parser.add_argument("--merge-gap", type=float, default=0.2, help="Merge gap between segments in sec (default: 0.2)")
    parser.add_argument("--fps", type=float, default=29.97, help="Sequence frame rate (default: 29.97)")
    parser.add_argument("--json", action="store_true", help="Output full result as JSON")
    parser.add_argument("--output", "-o", help="Save result JSON to file")

    args = parser.parse_args()

    if not os.path.isfile(args.media_path):
        print(f"Error: File not found: {args.media_path}", file=sys.stderr)
        sys.exit(1)

    pipeline = SilenceDetectorPipeline()

    settings = {
        "noise_db": args.noise_db,
        "min_silence_duration": args.min_silence,
        "speech_threshold": args.speech_threshold,
        "keep_before": args.keep_before,
        "keep_after": args.keep_after,
        "merge_gap": args.merge_gap,
    }

    clip_info = {
        "clip_timeline_start": 0.0,
        "source_in_point": 0.0,
        "frame_rate": args.fps,
    }

    print(f"Analyzing '{args.media_path}' using {args.mode.upper()} mode...")
    result = pipeline.analyze(
        media_path=args.media_path,
        mode=args.mode,
        clip_info=clip_info,
        settings=settings,
        progress_cb=lambda pct, msg: print(f"[{pct*100:0.1f}%] {msg}"),
    )

    plan = pipeline.plan_edits(result["segments"])

    if args.json or args.output:
        full_payload = {
            "analysis": result,
            "edit_plan": plan,
        }
        json_str = json.dumps(full_payload, indent=2)
        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(json_str)
            print(f"Result saved to {args.output}")
        if args.json:
            print(json_str)
            return

    # Print summary table
    print("\n" + "=" * 80)
    print(" DETECTION RESULTS & PROPOSED EDIT ACTIONS")
    print("=" * 80)
    print(f"Mode: {result['mode'].upper()} | Clip Duration: {result['clip_source_duration']}s | Time: {result['processing_time_sec']}s")
    print(f"Silence Detected: {result['summary']['detected_silence_duration_sec']}s ({result['summary']['potential_time_saved_percent']}% reduction)")
    print(f"Ripple Deletes: {result['summary']['ripple_delete_count']} | Disables: {result['summary']['disable_count']} | Keep: {result['summary']['keep_count']}")
    print("-" * 80)
    print(f"{'#':<4} {'Start':<10} {'End':<10} {'Duration':<10} {'Action':<16} {'Badge':<4} {'Reason'}")
    print("-" * 80)

    for i, seg in enumerate(result["segments"], start=1):
        action_val = seg.get("action", "KEEP")
        action_name = action_val.value if hasattr(action_val, "value") else str(action_val)
        badge = seg.get("badge", "⚪")
        start_tc = seg.get("timecode_start", f"{seg['start']:.2f}s")
        end_tc = seg.get("timecode_end", f"{seg['end']:.2f}s")
        dur_str = f"{seg['duration']:.2f}s"
        reason = seg.get("label", seg.get("state", ""))
        print(f"{i:<4} {start_tc:<10} {end_tc:<10} {dur_str:<10} {action_name:<16} {badge:<4} {reason}")

    print("=" * 80)
    print(f"Edit Plan: {plan['summary']['total_operations']} operations (Execution Order: RIGHT -> LEFT)")
    print("=" * 80)


if __name__ == "__main__":
    main()
