/**
 * API Client for Silent Segment Detection Companion Server.
 * Connects to http://127.0.0.1:38271 (with localhost fallback).
 */

class ApiClient {
  constructor(baseUrl = "http://127.0.0.1:38271") {
    this.candidateUrls = ["http://127.0.0.1:38271", "http://localhost:38271"];
    this.baseUrl = baseUrl;
    this.isOnline = false;
    this.serverInfo = null;
  }

  /**
   * Internal HTTP request helper with fetch and XHR fallback for UXP environments
   */
  async _request(path, method = "GET", body = null) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      "Accept": "application/json",
    };
    if (body) {
      headers["Content-Type"] = "application/json";
    }

    // Try standard fetch first
    try {
      const resp = await fetch(url, {
        method: method,
        headers: headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!resp.ok) {
        let errDetail = "";
        try {
          const errJson = await resp.json();
          errDetail = errJson.error || "";
        } catch (_) {}
        throw new Error(errDetail || `HTTP ${resp.status} (${resp.statusText})`);
      }

      return await resp.json();
    } catch (fetchErr) {
      // If fetch fails, try XMLHttpRequest fallback for UXP host contexts
      if (typeof XMLHttpRequest !== "undefined") {
        return new Promise((resolve, reject) => {
          try {
            const xhr = new XMLHttpRequest();
            xhr.open(method, url, true);
            xhr.setRequestHeader("Accept", "application/json");
            if (body) {
              xhr.setRequestHeader("Content-Type", "application/json");
            }
            xhr.timeout = 10000;
            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                try {
                  const data = JSON.parse(xhr.responseText);
                  resolve(data);
                } catch (e) {
                  reject(new Error("Invalid JSON response from companion server."));
                }
              } else {
                reject(new Error(`HTTP ${xhr.status}: ${xhr.statusText}`));
              }
            };
            xhr.onerror = () => reject(new Error(fetchErr.message || "Network request failed"));
            xhr.ontimeout = () => reject(new Error("Connection timed out"));
            xhr.send(body ? JSON.stringify(body) : null);
          } catch (xhrErr) {
            reject(fetchErr);
          }
        });
      }
      throw fetchErr;
    }
  }

  async checkHealth() {
    let lastError = null;

    // First try the current primary baseUrl
    for (const url of [this.baseUrl, ...this.candidateUrls.filter(u => u !== this.baseUrl)]) {
      this.baseUrl = url;
      try {
        const data = await this._request("/health", "GET");
        if (data && data.status === "online") {
          this.isOnline = true;
          this.serverInfo = data;
          return { online: true, info: data, endpoint: this.baseUrl };
        }
      } catch (e) {
        lastError = e;
      }
    }

    this.isOnline = false;
    this.serverInfo = null;
    return {
      online: false,
      error: lastError ? lastError.message : "Connection refused",
      endpoint: this.baseUrl,
    };
  }

  async analyzeMedia({ mediaPath, mode = "accurate", clipInfo = null, settings = null }) {
    const payload = {
      media_path: mediaPath,
      mode: mode,
      clip_info: clipInfo,
      settings: settings,
    };

    return await this._request("/analyze", "POST", payload);
  }

  async planEdits({ segments, videoTracks = [0], audioTracks = [0], rippleAllTracks = true }) {
    const payload = {
      segments: segments,
      video_tracks: videoTracks,
      audio_tracks: audioTracks,
      ripple_all_tracks: rippleAllTracks,
    };

    return await this._request("/plan-edits", "POST", payload);
  }
}

window.ApiClient = ApiClient;
