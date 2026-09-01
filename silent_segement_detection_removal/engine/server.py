"""
Local Companion HTTP Server for Premiere Pro UXP Plugin.
Runs on 127.0.0.1:38271 and bridges UXP with FFmpeg and Silero VAD.
"""

import json
import os
import sys
import threading
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Optional

# Ensure UTF-8 stdout on Windows console
if sys.platform == "win32" and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

from .silence_detector import SilenceDetectorPipeline

DEFAULT_PORT = 38271


class SilenceServerHandler(BaseHTTPRequestHandler):
    pipeline: Optional[SilenceDetectorPipeline] = None

    def _set_cors_headers(self, status_code: int = 200, content_type: str = "application/json"):
        self.send_response(status_code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Content-Type", content_type)
        self.end_headers()

    def do_OPTIONS(self):
        self._set_cors_headers(200)

    def do_GET(self):
        if self.path == "/" or self.path == "/health":
            self._handle_health()
        else:
            self._set_cors_headers(404)
            self.wfile.write(json.dumps({"error": f"Endpoint not found: {self.path}"}).encode("utf-8"))

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else b"{}"

        try:
            data = json.loads(body.decode("utf-8")) if body else {}
        except Exception as e:
            self._set_cors_headers(400)
            self.wfile.write(json.dumps({"error": f"Invalid JSON payload: {e}"}).encode("utf-8"))
            return

        if self.path == "/analyze":
            self._handle_analyze(data)
        elif self.path == "/plan-edits":
            self._handle_plan_edits(data)
        elif self.path == "/shutdown":
            self._set_cors_headers(200)
            self.wfile.write(json.dumps({"status": "shutting_down"}).encode("utf-8"))
            threading.Thread(target=self.server.shutdown).start()
        else:
            self._set_cors_headers(404)
            self.wfile.write(json.dumps({"error": f"Endpoint not found: {self.path}"}).encode("utf-8"))

    def _handle_health(self):
        model_exists = False
        if self.pipeline and self.pipeline.model_path:
            model_exists = os.path.isfile(self.pipeline.model_path)

        res = {
            "status": "online",
            "service": "Silent Segment Detection Companion Server",
            "version": "1.0.0",
            "ffmpeg_available": True,
            "silero_model_available": model_exists,
        }
        self._set_cors_headers(200)
        self.wfile.write(json.dumps(res, indent=2).encode("utf-8"))

    def _handle_analyze(self, data: dict):
        media_path = data.get("media_path")
        if not media_path:
            self._set_cors_headers(400)
            self.wfile.write(json.dumps({"error": "Missing 'media_path' parameter"}).encode("utf-8"))
            return

        mode = data.get("mode", "accurate")
        clip_info = data.get("clip_info")
        settings = data.get("settings")

        try:
            result = self.pipeline.analyze(
                media_path=media_path,
                mode=mode,
                clip_info=clip_info,
                settings=settings,
                progress_cb=lambda pct, msg: sys.stdout.write(f"[{pct*100:0.1f}%] {msg}\n"),
            )
            self._set_cors_headers(200)
            self.wfile.write(json.dumps(result).encode("utf-8"))
        except Exception as e:
            traceback.print_exc()
            self._set_cors_headers(500)
            self.wfile.write(json.dumps({
                "error": str(e),
                "traceback": traceback.format_exc(),
            }).encode("utf-8"))

    def _handle_plan_edits(self, data: dict):
        segments = data.get("segments", [])
        video_tracks = data.get("video_tracks")
        audio_tracks = data.get("audio_tracks")
        ripple_all_tracks = data.get("ripple_all_tracks", True)

        try:
            plan = self.pipeline.plan_edits(
                analyzed_segments=segments,
                video_tracks=video_tracks,
                audio_tracks=audio_tracks,
                ripple_all_tracks=ripple_all_tracks,
            )
            self._set_cors_headers(200)
            self.wfile.write(json.dumps(plan).encode("utf-8"))
        except Exception as e:
            traceback.print_exc()
            self._set_cors_headers(500)
            self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))

    def log_message(self, format, *args):
        # Override to keep logs clean
        sys.stdout.write(f"[SilenceServer] {self.address_string()} - {format % args}\n")


def start_server(port: int = DEFAULT_PORT, model_path: Optional[str] = None):
    pipeline = SilenceDetectorPipeline(model_path=model_path)
    SilenceServerHandler.pipeline = pipeline

    server_address = ("127.0.0.1", port)
    httpd = HTTPServer(server_address, SilenceServerHandler)
    print(f"==================================================")
    print(f" Silent Segment Detection Server running on:")
    print(f" http://127.0.0.1:{port}")
    print(f" Ready for Premiere Pro UXP Plugin connections")
    print(f"==================================================")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
        httpd.server_close()


if __name__ == "__main__":
    port_arg = DEFAULT_PORT
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        port_arg = int(sys.argv[1])
    start_server(port=port_arg)
