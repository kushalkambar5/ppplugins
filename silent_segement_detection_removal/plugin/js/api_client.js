/**
 * API Client for Silent Segment Detection Companion Server.
 * Connects to http://127.0.0.1:38271
 */

class ApiClient {
  constructor(baseUrl = "http://127.0.0.1:38271") {
    this.baseUrl = baseUrl;
    this.isOnline = false;
    this.serverInfo = null;
  }

  async checkHealth() {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        method: "GET",
        headers: { "Accept": "application/json" },
        cache: "no-cache",
      });

      if (!resp.ok) {
        throw new Error(`Server returned status ${resp.status}`);
      }

      const data = await resp.json();
      this.isOnline = data.status === "online";
      this.serverInfo = data;
      return { online: true, info: data };
    } catch (e) {
      this.isOnline = false;
      this.serverInfo = null;
      return { online: false, error: e.message };
    }
  }

  async analyzeMedia({ mediaPath, mode = "accurate", clipInfo = null, settings = null }) {
    const payload = {
      media_path: mediaPath,
      mode: mode,
      clip_info: clipInfo,
      settings: settings,
    };

    const resp = await fetch(`${this.baseUrl}/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errJson = await resp.json().catch(() => ({}));
      throw new Error(errJson.error || `Analysis request failed with status ${resp.status}`);
    }

    return await resp.json();
  }

  async planEdits({ segments, videoTracks = [0], audioTracks = [0], rippleAllTracks = true }) {
    const payload = {
      segments: segments,
      video_tracks: videoTracks,
      audio_tracks: audioTracks,
      ripple_all_tracks: rippleAllTracks,
    };

    const resp = await fetch(`${this.baseUrl}/plan-edits`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errJson = await resp.json().catch(() => ({}));
      throw new Error(errJson.error || `Edit plan generation failed with status ${resp.status}`);
    }

    return await resp.json();
  }
}

window.ApiClient = ApiClient;
