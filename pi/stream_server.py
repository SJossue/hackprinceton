"""
Rewind — Pi-side raw camera streamer (no YOLO).
Streams MJPEG over HTTP so the laptop can pull frames and run inference.

Run on Pi:  python stream_server.py
View:       http://<pi-ip>:9090
"""

from __future__ import annotations

import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2

CAMERA_INDEX = 0
FRAME_W, FRAME_H = 640, 480
STREAM_PORT = 9090
TARGET_FPS = 21

_frame_lock = threading.Lock()
_current_frame: bytes = b""


class MJPEGHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.end_headers()
        try:
            while True:
                with _frame_lock:
                    jpg = _current_frame
                if jpg:
                    self.wfile.write(b"--frame\r\n")
                    self.wfile.write(b"Content-Type: image/jpeg\r\n\r\n")
                    self.wfile.write(jpg)
                    self.wfile.write(b"\r\n")
                time.sleep(1 / TARGET_FPS)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, format: str, *args: object) -> None:
        pass


def capture_loop() -> None:
    global _current_frame
    cap = cv2.VideoCapture(CAMERA_INDEX)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, FRAME_W)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_H)
    cap.set(cv2.CAP_PROP_FPS, TARGET_FPS)
    if not cap.isOpened():
        raise RuntimeError("camera failed to open")

    print(f"[stream] camera open @ {FRAME_W}x{FRAME_H} target {TARGET_FPS}fps")
    period = 1.0 / TARGET_FPS
    while True:
        t0 = time.time()
        ok, frame = cap.read()
        if not ok:
            continue
        _, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        with _frame_lock:
            _current_frame = jpg.tobytes()
        dt = time.time() - t0
        if dt < period:
            time.sleep(period - dt)


def main() -> None:
    threading.Thread(target=capture_loop, daemon=True).start()
    print(f"[stream] serving MJPEG on http://0.0.0.0:{STREAM_PORT}")
    # ThreadingHTTPServer so multiple clients (laptop capture + Chrome debug +
    # phone display, etc.) can all watch the stream concurrently. Plain
    # HTTPServer is single-threaded and silently starves new clients while one
    # is connected — that caused capture_local.py to hang on 'cannot open
    # stream' whenever another browser tab was already watching.
    server = ThreadingHTTPServer(("0.0.0.0", STREAM_PORT), MJPEGHandler)
    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[stream] shutting down.")


if __name__ == "__main__":
    main()
