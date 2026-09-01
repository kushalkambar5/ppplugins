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

    def _send_json(self, data: dict, status_code: int = 200):
        try:
            body = json.dumps(data, indent=2).encode("utf-8")
            self.send_response(status_code)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, X-Requested-With")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        try:
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, X-Requested-With")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "86400")
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path == "/" or self.path == "/health":
            self._handle_health()
        else:
            self._send_json({"error": f"Endpoint not found: {self.path}"}, 404)

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else b"{}"

        try:
            data = json.loads(body.decode("utf-8")) if body else {}
        except Exception as e:
            self._send_json({"error": f"Invalid JSON payload: {e}"}, 400)
            return

        if self.path == "/analyze":
            self._handle_analyze(data)
        elif self.path == "/plan-edits":
            self._handle_plan_edits(data)
        elif self.path == "/shutdown":
            self._send_json({"status": "shutting_down"}, 200)
            threading.Thread(target=self.server.shutdown).start()
        else:
            self._send_json({"error": f"Endpoint not found: {self.path}"}, 404)

    def _handle_health(self):
        model_exists = False
        model_path = None
        if self.pipeline and self.pipeline.model_path:
            model_path = self.pipeline.model_path
            model_exists = os.path.isfile(self.pipeline.model_path)
        else:
            base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            model_path = os.path.join(base_dir, "models", "silero_vad_16k_op15.onnx")
            model_exists = os.path.isfile(model_path)

        res = {
            "status": "online",
            "service": "Silent Segment Detection Companion Server",
            "version": "1.0.0",
            "port": DEFAULT_PORT,
            "ffmpeg_available": True,
            "silero_model_available": model_exists,
            "model_path": model_path if model_exists else None,
            "python_version": sys.version.split(" ")[0],
            "platform": sys.platform,
        }
        self._send_json(res, 200)

    def _handle_analyze(self, data: dict):
        media_path = data.get("media_path")
        if not media_path:
            self._send_json({"error": "Missing 'media_path' parameter"}, 400)
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
            self._send_json(result, 200)
        except Exception as e:
            traceback.print_exc()
            self._send_json({
                "error": str(e),
                "traceback": traceback.format_exc(),
            }, 500)

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
            self._send_json(plan, 200)
        except Exception as e:
            traceback.print_exc()
            self._send_json({"error": str(e)}, 500)

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
