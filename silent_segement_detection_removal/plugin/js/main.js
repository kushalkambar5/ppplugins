/**
 * Main Controller for Silent Segment Detection & Removal Plugin.
 */

document.addEventListener("DOMContentLoaded", () => {
  const api = new window.ApiClient();
  const adapter = new window.PremiereAdapter();

  // State
  let currentMode = "accurate"; // "fast" or "accurate"
  let activeClipInfo = null;
  let detectedSegments = [];
  let currentFilter = "ALL";

  // Elements
  const serverBadge = document.getElementById("server-badge");
  const serverStatusText = document.getElementById("server-status-text");
  const tabFast = document.getElementById("tab-fast");
  const tabAccurate = document.getElementById("tab-accurate");
  const accurateOnlySettings = document.querySelectorAll(".accurate-only");

  // Settings Elements
  const noiseDbSlider = document.getElementById("noise-db-slider");
  const noiseDbVal = document.getElementById("noise-db-val");
  const minSilenceSlider = document.getElementById("min-silence-slider");
  const minSilenceVal = document.getElementById("min-silence-val");
  const speechThreshSlider = document.getElementById("speech-thresh-slider");
  const speechThreshVal = document.getElementById("speech-thresh-val");
  const keepBeforeInput = document.getElementById("keep-before-input");
  const keepAfterInput = document.getElementById("keep-after-input");
  const mergeGapInput = document.getElementById("merge-gap-input");

  // Clip Info Elements
  const clipNameEl = document.getElementById("clip-name");
  const clipTrackEl = document.getElementById("clip-track");
  const clipDurationEl = document.getElementById("clip-duration");
  const clipFpsEl = document.getElementById("clip-fps");
  const btnRefreshClip = document.getElementById("btn-refresh-clip");

  // Action Elements
  const btnAnalyze = document.getElementById("btn-analyze");
  const progressContainer = document.getElementById("progress-container");
  const progressBarFill = document.getElementById("progress-bar-fill");
  const progressStatusText = document.getElementById("progress-status-text");

  // Preview Elements
  const previewSection = document.getElementById("preview-section");
  const previewTbody = document.getElementById("preview-tbody");
  const filterSelect = document.getElementById("filter-select");
  const btnBulkRipple = document.getElementById("btn-bulk-ripple");
  const btnBulkDisable = document.getElementById("btn-bulk-disable");
  const btnBulkKeep = document.getElementById("btn-bulk-keep");

  // Footer Elements
  const totalOpsCountEl = document.getElementById("total-ops-count");
  const timeSavedEl = document.getElementById("time-saved");
  const btnApply = document.getElementById("btn-apply");
  const logDrawer = document.getElementById("log-drawer");

  // 1. Health check loop
  async function updateHealth() {
    const res = await api.checkHealth();
    if (res.online) {
      serverBadge.className = "server-badge online";
      serverStatusText.textContent = "Engine Connected";
    } else {
      serverBadge.className = "server-badge offline";
      serverStatusText.textContent = "Engine Disconnected (Start Server)";
    }
  }

  updateHealth();
  setInterval(updateHealth, 5000);
  serverBadge.addEventListener("click", updateHealth);

  // 2. Tab switcher
  tabFast.addEventListener("click", () => {
    currentMode = "fast";
    tabFast.classList.add("active");
    tabAccurate.classList.remove("active");
    accurateOnlySettings.forEach(el => (el.style.display = "none"));
  });

  tabAccurate.addEventListener("click", () => {
    currentMode = "accurate";
    tabAccurate.classList.add("active");
    tabFast.classList.remove("active");
    accurateOnlySettings.forEach(el => (el.style.display = "flex"));
  });

  // 3. Sliders & Input Sync
  noiseDbSlider.addEventListener("input", e => {
    noiseDbVal.textContent = `${e.target.value} dB`;
  });
  minSilenceSlider.addEventListener("input", e => {
    minSilenceVal.textContent = `${parseFloat(e.target.value).toFixed(2)}s`;
  });
  if (speechThreshSlider) {
    speechThreshSlider.addEventListener("input", e => {
      speechThreshVal.textContent = `${parseFloat(e.target.value).toFixed(2)}`;
    });
  }

  // 4. Clip Selection Refresh
  async function refreshSelection() {
    try {
      btnRefreshClip.disabled = true;
      activeClipInfo = await adapter.getSelectedClip();
      clipNameEl.textContent = activeClipInfo.name;
      clipTrackEl.textContent = `${activeClipInfo.trackType.toUpperCase()} ${activeClipInfo.trackIndex + 1}`;
      clipDurationEl.textContent = `${activeClipInfo.duration.toFixed(2)}s`;
      clipFpsEl.textContent = `${activeClipInfo.frameRate} fps`;
      btnAnalyze.disabled = false;
      logMessage(`Selected Clip: ${activeClipInfo.name} (${activeClipInfo.duration.toFixed(2)}s, ${activeClipInfo.frameRate} fps)`);
    } catch (err) {
      clipNameEl.textContent = "None Selected";
      clipTrackEl.textContent = "-";
      clipDurationEl.textContent = "-";
      clipFpsEl.textContent = "-";
      logMessage(`Selection warning: ${err.message}`);
    } finally {
      btnRefreshClip.disabled = false;
    }
  }

  btnRefreshClip.addEventListener("click", refreshSelection);
  refreshSelection();

  // 5. Analyze Selection
  btnAnalyze.addEventListener("click", async () => {
    if (!activeClipInfo) {
      await refreshSelection();
      if (!activeClipInfo) {
        alert("Please select a clip on the Premiere Pro timeline first.");
        return;
      }
    }

    const settings = {
      noise_db: parseFloat(noiseDbSlider.value),
      min_silence_duration: parseFloat(minSilenceSlider.value),
      speech_threshold: speechThreshSlider ? parseFloat(speechThreshSlider.value) : 0.5,
      keep_before: parseFloat(keepBeforeInput.value) || 0.1,
      keep_after: parseFloat(keepAfterInput.value) || 0.1,
      merge_gap: parseFloat(mergeGapInput.value) || 0.2,
      min_final_duration: 0.2,
    };

    const clipInfoPayload = {
      clip_timeline_start: activeClipInfo.clipTimelineStart,
      clip_timeline_end: activeClipInfo.clipTimelineEnd,
      source_in_point: activeClipInfo.sourceInPoint,
      source_out_point: activeClipInfo.sourceOutPoint,
      frame_rate: activeClipInfo.frameRate,
      speed: 1.0,
      is_reversed: false,
    };

    try {
      setLoading(true, "Analyzing audio with FFmpeg & Silero VAD...");
      logMessage(`Starting ${currentMode.toUpperCase()} analysis on: ${activeClipInfo.mediaPath}`);

      const result = await api.analyzeMedia({
        mediaPath: activeClipInfo.mediaPath,
        mode: currentMode,
        clipInfo: clipInfoPayload,
        settings: settings,
      });

      detectedSegments = result.segments || [];
      logMessage(`Analysis completed in ${result.processing_time_sec}s. Found ${detectedSegments.length} segments.`);

      renderPreviewTable();
      updateSummary();
      btnApply.disabled = detectedSegments.length === 0;
    } catch (err) {
      logMessage(`Analysis Error: ${err.message}`);
      alert(`Detection failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  });

  // 6. Preview Table Rendering
  function renderPreviewTable() {
    previewTbody.innerHTML = "";

    const filtered = detectedSegments.filter(seg => {
      if (currentFilter === "ALL") return true;
      return seg.action === currentFilter;
    });

    if (filtered.length === 0) {
      previewTbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:15px; color:#777;">No segments match the current filter.</td></tr>`;
      return;
    }

    filtered.forEach((seg, idx) => {
      const tr = document.createElement("tr");

      // Badge style
      let badgeClass = "badge-gray";
      if (seg.action === "RIPPLE_DELETE") badgeClass = "badge-green";
      else if (seg.action === "DISABLE") badgeClass = "badge-yellow";

      const startTc = seg.timecode_start || `${seg.start.toFixed(2)}s`;
      const endTc = seg.timecode_end || `${seg.end.toFixed(2)}s`;
      const durStr = `${seg.duration.toFixed(2)}s`;
      const reasonStr = seg.label || seg.description || seg.state;

      tr.innerHTML = `
        <td style="font-family:monospace;">${startTc} → ${endTc}</td>
        <td>${durStr}</td>
        <td><span class="badge ${badgeClass}">${seg.badge || ""} ${seg.label || seg.state}</span></td>
        <td>
          <select class="action-select" data-index="${idx}">
            <option value="RIPPLE_DELETE" ${seg.action === "RIPPLE_DELETE" ? "selected" : ""}>🟢 Ripple Delete</option>
            <option value="DISABLE" ${seg.action === "DISABLE" ? "selected" : ""}>🟡 Disable</option>
            <option value="KEEP" ${seg.action === "KEEP" ? "selected" : ""}>⚪ Keep</option>
          </select>
        </td>
      `;

      const selectEl = tr.querySelector(".action-select");
      selectEl.addEventListener("change", e => {
        seg.action = e.target.value;
        if (seg.action === "RIPPLE_DELETE") seg.badge = "🟢";
        else if (seg.action === "DISABLE") seg.badge = "🟡";
        else seg.badge = "⚪";
        renderPreviewTable();
        updateSummary();
      });

      previewTbody.appendChild(tr);
    });
  }

  // 7. Bulk Action Overrides
  btnBulkRipple.addEventListener("click", () => {
    detectedSegments.forEach(s => {
      if (s.state === "CONFIRMED_SILENCE" || s.state === "SILENCE" || s.action !== "KEEP") {
        s.action = "RIPPLE_DELETE";
        s.badge = "🟢";
      }
    });
    renderPreviewTable();
    updateSummary();
  });

  btnBulkDisable.addEventListener("click", () => {
    detectedSegments.forEach(s => {
      if (s.action !== "KEEP") {
        s.action = "DISABLE";
        s.badge = "🟡";
      }
    });
    renderPreviewTable();
    updateSummary();
  });

  btnBulkKeep.addEventListener("click", () => {
    detectedSegments.forEach(s => {
      s.action = "KEEP";
      s.badge = "⚪";
    });
    renderPreviewTable();
    updateSummary();
  });

  filterSelect.addEventListener("change", e => {
    currentFilter = e.target.value;
    renderPreviewTable();
  });

  // 8. Summary calculation
  function updateSummary() {
    const rippleOps = detectedSegments.filter(s => s.action === "RIPPLE_DELETE");
    const disableOps = detectedSegments.filter(s => s.action === "DISABLE");
    const totalActive = rippleOps.length + disableOps.length;

    const timeSaved = rippleOps.reduce((acc, s) => acc + s.duration, 0);

    totalOpsCountEl.textContent = `${totalActive} edits (${rippleOps.length} ripples, ${disableOps.length} disables)`;
    timeSavedEl.textContent = `Time saved: ~${timeSaved.toFixed(2)}s`;
    btnApply.disabled = totalActive === 0;
  }

  // 9. Apply Edits to Timeline
  btnApply.addEventListener("click", async () => {
    if (detectedSegments.length === 0) return;

    try {
      setLoading(true, "Planning Right -> Left timeline operations...");
      logMessage("Generating Right-to-Left edit plan...");

      const editPlan = await api.planEdits({
        segments: detectedSegments,
        videoTracks: [activeClipInfo ? activeClipInfo.trackIndex : 0],
        audioTracks: [0, 1],
        rippleAllTracks: true,
      });

      logMessage(`Plan ready: ${editPlan.summary.total_operations} operations sorted RIGHT -> LEFT.`);
      setLoading(true, `Applying ${editPlan.summary.total_operations} cuts to Premiere Pro timeline...`);

      const execResult = await adapter.executeEditPlan(editPlan, (pct, status) => {
        progressBarFill.style.width = `${pct * 100}%`;
        progressStatusText.textContent = status;
        logMessage(status);
      });

      logMessage(`Result: ${execResult.message}`);
      alert(`Success!\n${execResult.message}\nTotal time reduction: ${editPlan.summary.total_time_saved_sec}s`);

      // Refresh selection
      await refreshSelection();
    } catch (err) {
      logMessage(`Apply Edits Error: ${err.message}`);
      alert(`Failed to apply edits: ${err.message}`);
    } finally {
      setLoading(false);
    }
  });

  // Helper UI utilities
  function setLoading(isLoading, statusText = "") {
    if (isLoading) {
      progressContainer.style.display = "flex";
      progressBarFill.style.width = "40%";
      progressStatusText.textContent = statusText;
      btnAnalyze.disabled = true;
      btnApply.disabled = true;
    } else {
      progressContainer.style.display = "none";
      progressBarFill.style.width = "0%";
      btnAnalyze.disabled = false;
      updateSummary();
    }
  }

  function logMessage(msg) {
    const timestamp = new Date().toLocaleTimeString();
    const entry = `[${timestamp}] ${msg}`;
    console.log(entry);
    const line = document.createElement("div");
    line.textContent = entry;
    logDrawer.appendChild(line);
    logDrawer.scrollTop = logDrawer.scrollHeight;
  }
});
