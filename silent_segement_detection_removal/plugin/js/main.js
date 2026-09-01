/**
 * Main Controller for Silent Segment Detection & Removal Plugin.
 * Professional Premiere Pro Panel UI/UX Controller.
 */

document.addEventListener("DOMContentLoaded", () => {
  const api = new window.ApiClient();
  const adapter = new window.PremiereAdapter();

  // State
  let currentMode = "accurate"; // "fast" or "accurate"
  let activeClipInfo = null;
  let detectedSegments = [];
  let currentFilter = "ALL";
  let activePreset = "podcast";

  // Header & Diagnostics Elements
  const serverBadge = document.getElementById("server-badge");
  const serverStatusText = document.getElementById("server-status-text");
  const diagPopover = document.getElementById("diagnostics-popover");
  const btnCloseDiag = document.getElementById("btn-close-diag");
  const diagStatus = document.getElementById("diag-status");
  const diagFfmpeg = document.getElementById("diag-ffmpeg");
  const diagSilero = document.getElementById("diag-silero");
  const btnReconnectNow = document.getElementById("btn-reconnect-now");
  const btnCopyCmd = document.getElementById("btn-copy-cmd");

  // Mode Tabs
  const tabFast = document.getElementById("tab-fast");
  const tabAccurate = document.getElementById("tab-accurate");
  const accurateOnlySettings = document.querySelectorAll(".accurate-only");

  // Presets Elements
  const presetPodcast = document.getElementById("preset-podcast");
  const presetAggressive = document.getElementById("preset-aggressive");
  const presetGentle = document.getElementById("preset-gentle");
  const presetCustom = document.getElementById("preset-custom");
  const presetChips = [presetPodcast, presetAggressive, presetGentle, presetCustom];

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
  const btnRefreshClip = document.getElementById("btn-refresh-clip");

  // Action & Progress Elements
  const btnAnalyze = document.getElementById("btn-analyze");
  const progressCard = document.getElementById("progress-card");
  const progressBarFill = document.getElementById("progress-bar-fill");
  const progressStatusText = document.getElementById("progress-status-text");
  const progressPctText = document.getElementById("progress-pct-text");

  // Preview & Table Elements
  const previewTbody = document.getElementById("preview-tbody");
  const filterChips = document.querySelectorAll(".filter-chip");
  const countAll = document.getElementById("count-all");
  const countRipple = document.getElementById("count-ripple");
  const countDisable = document.getElementById("count-disable");
  const countKeep = document.getElementById("count-keep");
  const btnBulkRipple = document.getElementById("btn-bulk-ripple");
  const btnBulkDisable = document.getElementById("btn-bulk-disable");
  const btnBulkKeep = document.getElementById("btn-bulk-keep");

  // Footer & KPIs Elements
  const totalOpsCountEl = document.getElementById("total-ops-count");
  const timeSavedEl = document.getElementById("time-saved");
  const btnApply = document.getElementById("btn-apply");
  const drawerToggle = document.getElementById("drawer-toggle");
  const drawerArrow = document.getElementById("drawer-arrow");
  const logDrawer = document.getElementById("log-drawer");

  // =========================================================================
  // 1. Health Check & Diagnostics
  // =========================================================================
  async function updateHealth() {
    const res = await api.checkHealth();
    if (res.online && res.info) {
      serverBadge.className = "status-pill online";
      serverStatusText.textContent = "Engine Connected";

      diagStatus.textContent = "Online";
      diagStatus.className = "diag-val ok";

      diagFfmpeg.textContent = res.info.ffmpeg_available ? "Available" : "Not Found";
      diagFfmpeg.className = res.info.ffmpeg_available ? "diag-val ok" : "diag-val fail";

      diagSilero.textContent = res.info.silero_model_available ? "Ready (CPU)" : "Model Missing";
      diagSilero.className = res.info.silero_model_available ? "diag-val ok" : "diag-val fail";
    } else {
      serverBadge.className = "status-pill offline";
      serverStatusText.textContent = "Engine Offline (Start Server)";

      diagStatus.textContent = "Disconnected";
      diagStatus.className = "diag-val fail";

      diagFfmpeg.textContent = "Unknown";
      diagFfmpeg.className = "diag-val fail";

      diagSilero.textContent = "Unknown";
      diagSilero.className = "diag-val fail";
    }
  }

  updateHealth();
  setInterval(updateHealth, 5000);

  // Diagnostics Flyout Toggling
  serverBadge.addEventListener("click", (e) => {
    e.stopPropagation();
    diagPopover.classList.toggle("show");
  });

  if (btnCloseDiag) {
    btnCloseDiag.addEventListener("click", () => {
      diagPopover.classList.remove("show");
    });
  }

  document.addEventListener("click", (e) => {
    if (!diagPopover.contains(e.target) && e.target !== serverBadge) {
      diagPopover.classList.remove("show");
    }
  });

  if (btnReconnectNow) {
    btnReconnectNow.addEventListener("click", async () => {
      btnReconnectNow.disabled = true;
      btnReconnectNow.textContent = "Connecting...";
      await updateHealth();
      setTimeout(() => {
        btnReconnectNow.disabled = false;
        btnReconnectNow.innerHTML = `
          <svg class="svg-icon" viewBox="0 0 24 24">
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
          </svg> Reconnect
        `;
      }, 500);
    });
  }

  if (btnCopyCmd) {
    btnCopyCmd.addEventListener("click", () => {
      const cmd = "python -m engine.server 38271";
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cmd);
      }
      logMessage(`Copied server launch command: ${cmd}`, "info");
      btnCopyCmd.title = "Copied to clipboard!";
      setTimeout(() => (btnCopyCmd.title = "Copy server startup command"), 2000);
    });
  }

  // =========================================================================
  // 2. Mode Switching (Accurate VAD vs Fast FFmpeg)
  // =========================================================================
  tabFast.addEventListener("click", () => {
    currentMode = "fast";
    tabFast.classList.add("active");
    tabAccurate.classList.remove("active");
    accurateOnlySettings.forEach(el => (el.style.display = "none"));
    logMessage("Switched mode to: Fast Mode (FFmpeg amplitude gate)", "info");
  });

  tabAccurate.addEventListener("click", () => {
    currentMode = "accurate";
    tabAccurate.classList.add("active");
    tabFast.classList.remove("active");
    accurateOnlySettings.forEach(el => (el.style.display = "flex"));
    logMessage("Switched mode to: Accurate Mode (Silero Neural VAD)", "info");
  });

  // =========================================================================
  // 3. Workflow Presets
  // =========================================================================
  const PRESET_CONFIGS = {
    podcast: { noiseDb: -35, minSilence: 0.45, speechThresh: 0.50, keepBefore: 0.12, keepAfter: 0.12, mergeGap: 0.20 },
    aggressive: { noiseDb: -30, minSilence: 0.25, speechThresh: 0.40, keepBefore: 0.06, keepAfter: 0.06, mergeGap: 0.15 },
    gentle: { noiseDb: -42, minSilence: 0.75, speechThresh: 0.60, keepBefore: 0.20, keepAfter: 0.20, mergeGap: 0.30 },
  };

  function applyPreset(name) {
    activePreset = name;
    presetChips.forEach(chip => {
      if (chip) chip.classList.toggle("active", chip.id === `preset-${name}`);
    });

    const cfg = PRESET_CONFIGS[name];
    if (cfg) {
      noiseDbSlider.value = cfg.noiseDb;
      noiseDbVal.textContent = `${cfg.noiseDb} dB`;

      minSilenceSlider.value = cfg.minSilence;
      minSilenceVal.textContent = `${cfg.minSilence.toFixed(2)}s`;

      if (speechThreshSlider) {
        speechThreshSlider.value = cfg.speechThresh;
        speechThreshVal.textContent = `${cfg.speechThresh.toFixed(2)}`;
      }

      keepBeforeInput.value = cfg.keepBefore.toFixed(2);
      keepAfterInput.value = cfg.keepAfter.toFixed(2);
      mergeGapInput.value = cfg.mergeGap.toFixed(2);
      logMessage(`Applied workflow preset: ${name.toUpperCase()}`, "info");
    }
  }

  if (presetPodcast) presetPodcast.addEventListener("click", () => applyPreset("podcast"));
  if (presetAggressive) presetAggressive.addEventListener("click", () => applyPreset("aggressive"));
  if (presetGentle) presetGentle.addEventListener("click", () => applyPreset("gentle"));
  if (presetCustom) {
    presetCustom.addEventListener("click", () => {
      activePreset = "custom";
      presetChips.forEach(c => c && c.classList.toggle("active", c.id === "preset-custom"));
    });
  }

  function markCustom() {
    activePreset = "custom";
    presetChips.forEach(c => c && c.classList.toggle("active", c.id === "preset-custom"));
  }

  // =========================================================================
  // 4. Sliders, Steppers & Numeric Inputs
  // =========================================================================
  noiseDbSlider.addEventListener("input", (e) => {
    noiseDbVal.textContent = `${e.target.value} dB`;
    markCustom();
  });

  minSilenceSlider.addEventListener("input", (e) => {
    minSilenceVal.textContent = `${parseFloat(e.target.value).toFixed(2)}s`;
    markCustom();
  });

  if (speechThreshSlider) {
    speechThreshSlider.addEventListener("input", (e) => {
      speechThreshVal.textContent = `${parseFloat(e.target.value).toFixed(2)}`;
      markCustom();
    });
  }

  // Stepper buttons (+ and -)
  document.querySelectorAll(".stepper-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-target");
      const step = parseFloat(btn.getAttribute("data-step") || "0.02");
      const input = document.getElementById(targetId);
      if (input) {
        let val = parseFloat(input.value) || 0;
        val = Math.max(0, val + step);
        input.value = val.toFixed(2);
        markCustom();
      }
    });
  });

  [keepBeforeInput, keepAfterInput, mergeGapInput].forEach((input) => {
    if (input) {
      input.addEventListener("change", markCustom);
    }
  });

  // =========================================================================
  // 5. Timeline Clip Selection Refresh
  // =========================================================================
  async function refreshSelection() {
    try {
      btnRefreshClip.disabled = true;
      activeClipInfo = await adapter.getSelectedClip();

      clipNameEl.textContent = activeClipInfo.name;
      clipNameEl.title = activeClipInfo.name;

      clipTrackEl.textContent = `${activeClipInfo.trackType.toUpperCase()} ${activeClipInfo.trackIndex + 1} • ${activeClipInfo.frameRate} fps`;
      clipDurationEl.textContent = `${activeClipInfo.duration.toFixed(2)}s`;

      btnAnalyze.disabled = false;
      logMessage(`Active Clip: ${activeClipInfo.name} (${activeClipInfo.duration.toFixed(2)}s @ ${activeClipInfo.frameRate} fps)`, "success");
    } catch (err) {
      clipNameEl.textContent = "No Timeline Clip Selected";
      clipNameEl.title = "Please click a clip in your active sequence";
      clipTrackEl.textContent = "-";
      clipDurationEl.textContent = "-";
      logMessage(`Selection notice: ${err.message}`, "warn");
    } finally {
      btnRefreshClip.disabled = false;
    }
  }

  btnRefreshClip.addEventListener("click", refreshSelection);
  refreshSelection();

  // =========================================================================
  // 6. Analyze Selection
  // =========================================================================
  btnAnalyze.addEventListener("click", async () => {
    if (!activeClipInfo) {
      await refreshSelection();
      if (!activeClipInfo) {
        alert("Please select a video or audio clip on the Premiere Pro timeline first.");
        return;
      }
    }

    const settings = {
      noise_db: parseFloat(noiseDbSlider.value),
      min_silence_duration: parseFloat(minSilenceSlider.value),
      speech_threshold: speechThreshSlider ? parseFloat(speechThreshSlider.value) : 0.5,
      keep_before: parseFloat(keepBeforeInput.value) || 0.12,
      keep_after: parseFloat(keepAfterInput.value) || 0.12,
      merge_gap: parseFloat(mergeGapInput.value) || 0.20,
      min_final_duration: 0.20,
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
      setLoading(true, "Scanning audio waveforms with FFmpeg & Silero VAD...");
      logMessage(`Starting ${currentMode.toUpperCase()} silence analysis on: ${activeClipInfo.name}`, "info");

      const result = await api.analyzeMedia({
        mediaPath: activeClipInfo.mediaPath,
        mode: currentMode,
        clipInfo: clipInfoPayload,
        settings: settings,
      });

      detectedSegments = result.segments || [];
      logMessage(`Analysis complete in ${result.processing_time_sec}s. Identified ${detectedSegments.length} segments.`, "success");

      renderPreviewTable();
      updateSummary();
      btnApply.disabled = detectedSegments.length === 0;
    } catch (err) {
      logMessage(`Analysis Error: ${err.message}`, "error");
      alert(`Detection failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  });

  // =========================================================================
  // 7. Preview Results Table & Filter Chips
  // =========================================================================
  filterChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      filterChips.forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      currentFilter = chip.getAttribute("data-filter") || "ALL";
      renderPreviewTable();
    });
  });

  function updateFilterCounts() {
    const all = detectedSegments.length;
    const ripple = detectedSegments.filter(s => s.action === "RIPPLE_DELETE").length;
    const disable = detectedSegments.filter(s => s.action === "DISABLE").length;
    const keep = detectedSegments.filter(s => s.action === "KEEP").length;

    if (countAll) countAll.textContent = all;
    if (countRipple) countRipple.textContent = ripple;
    if (countDisable) countDisable.textContent = disable;
    if (countKeep) countKeep.textContent = keep;
  }

  function renderPreviewTable() {
    previewTbody.innerHTML = "";
    updateFilterCounts();

    const filtered = detectedSegments.filter(seg => {
      if (currentFilter === "ALL") return true;
      return seg.action === currentFilter;
    });

    if (filtered.length === 0) {
      previewTbody.innerHTML = `
        <tr>
          <td colspan="4">
            <div class="table-empty-state">
              <div class="empty-icon-wrap">
                <svg class="svg-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><line x1="8" y1="12" x2="16" y2="12"></line></svg>
              </div>
              <div class="empty-title">No Segments in Filter</div>
              <div class="empty-desc">No detected intervals match the "${currentFilter}" filter category.</div>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    filtered.forEach((seg, idx) => {
      const tr = document.createElement("tr");

      let badgeClass = "badge-slate";
      let badgeLabel = seg.label || seg.state || "KEEP";

      if (seg.action === "RIPPLE_DELETE") {
        badgeClass = "badge-green";
      } else if (seg.action === "DISABLE") {
        badgeClass = "badge-amber";
      }

      const startTc = seg.timecode_start || `${seg.start.toFixed(2)}s`;
      const endTc = seg.timecode_end || `${seg.end.toFixed(2)}s`;
      const durStr = `${seg.duration.toFixed(2)}s`;

      tr.innerHTML = `
        <td>
          <span class="timecode-chip">${startTc} → ${endTc}</span>
        </td>
        <td>
          <span style="font-family:var(--font-mono); font-weight:600;">${durStr}</span>
        </td>
        <td>
          <span class="status-badge ${badgeClass}">${badgeLabel}</span>
        </td>
        <td style="text-align:right;">
          <select class="row-action-select" data-index="${idx}">
            <option value="RIPPLE_DELETE" ${seg.action === "RIPPLE_DELETE" ? "selected" : ""}>Ripple Delete</option>
            <option value="DISABLE" ${seg.action === "DISABLE" ? "selected" : ""}>Disable</option>
            <option value="KEEP" ${seg.action === "KEEP" ? "selected" : ""}>Keep</option>
          </select>
        </td>
      `;

      const selectEl = tr.querySelector(".row-action-select");
      selectEl.addEventListener("change", (e) => {
        seg.action = e.target.value;
        renderPreviewTable();
        updateSummary();
      });

      previewTbody.appendChild(tr);
    });
  }

  // =========================================================================
  // 8. Bulk Action Buttons
  // =========================================================================
  btnBulkRipple.addEventListener("click", () => {
    detectedSegments.forEach((s) => {
      if (s.state === "CONFIRMED_SILENCE" || s.state === "SILENCE" || s.action !== "KEEP") {
        s.action = "RIPPLE_DELETE";
      }
    });
    renderPreviewTable();
    updateSummary();
    logMessage("Bulk action applied: ALL RIPPLE DELETE", "info");
  });

  btnBulkDisable.addEventListener("click", () => {
    detectedSegments.forEach((s) => {
      if (s.action !== "KEEP") {
        s.action = "DISABLE";
      }
    });
    renderPreviewTable();
    updateSummary();
    logMessage("Bulk action applied: ALL DISABLE", "info");
  });

  btnBulkKeep.addEventListener("click", () => {
    detectedSegments.forEach((s) => {
      s.action = "KEEP";
    });
    renderPreviewTable();
    updateSummary();
    logMessage("Bulk action applied: RESET / KEEP ALL", "info");
  });

  // =========================================================================
  // 9. Summary & KPI Metrics
  // =========================================================================
  function updateSummary() {
    const rippleOps = detectedSegments.filter(s => s.action === "RIPPLE_DELETE");
    const disableOps = detectedSegments.filter(s => s.action === "DISABLE");
    const totalActive = rippleOps.length + disableOps.length;

    const timeSaved = rippleOps.reduce((acc, s) => acc + s.duration, 0);
    const clipDur = activeClipInfo ? activeClipInfo.duration : 1.0;
    const pctSaved = Math.min(100, Math.round((timeSaved / Math.max(0.1, clipDur)) * 100));

    totalOpsCountEl.textContent = `${totalActive} cuts (${rippleOps.length} ripples, ${disableOps.length} disables)`;
    timeSavedEl.textContent = `-${timeSaved.toFixed(2)}s (${pctSaved}%)`;
    btnApply.disabled = totalActive === 0;
  }

  // =========================================================================
  // 10. Apply Edits to Timeline (Right -> Left Engine)
  // =========================================================================
  btnApply.addEventListener("click", async () => {
    if (detectedSegments.length === 0) return;

    try {
      setLoading(true, "Compiling Right-to-Left edit plan...");
      logMessage("Compiling Right-to-Left non-destructive edit plan...", "info");

      const editPlan = await api.planEdits({
        segments: detectedSegments,
        videoTracks: [activeClipInfo ? activeClipInfo.trackIndex : 0],
        audioTracks: [0, 1],
        rippleAllTracks: true,
      });

      logMessage(`Plan ready: ${editPlan.summary.total_operations} cuts sorted RIGHT → LEFT to prevent timecode drift.`, "success");
      setLoading(true, `Executing ${editPlan.summary.total_operations} cuts on timeline...`);

      const execResult = await adapter.executeEditPlan(editPlan, (pct, status) => {
        progressBarFill.style.width = `${pct * 100}%`;
        progressPctText.textContent = `${Math.round(pct * 100)}%`;
        progressStatusText.textContent = status;
        logMessage(status, "info");
      });

      logMessage(`Execution Result: ${execResult.message}`, "success");
      alert(`Success!\n${execResult.message}\nTotal timeline reduction: ${editPlan.summary.total_time_saved_sec}s`);

      // Refresh selection
      await refreshSelection();
    } catch (err) {
      logMessage(`Apply Edits Error: ${err.message}`, "error");
      alert(`Failed to apply edits: ${err.message}`);
    } finally {
      setLoading(false);
    }
  });

  // =========================================================================
  // 11. Activity Drawer & UI Utilities
  // =========================================================================
  drawerToggle.addEventListener("click", () => {
    logDrawer.classList.toggle("open");
    drawerArrow.textContent = logDrawer.classList.contains("open") ? "▼" : "▲";
  });

  function setLoading(isLoading, statusText = "") {
    if (isLoading) {
      progressCard.style.display = "flex";
      progressBarFill.style.width = "35%";
      progressPctText.textContent = "Scanning...";
      progressStatusText.textContent = statusText;
      btnAnalyze.disabled = true;
      btnApply.disabled = true;
    } else {
      progressCard.style.display = "none";
      progressBarFill.style.width = "0%";
      progressPctText.textContent = "0%";
      btnAnalyze.disabled = false;
      updateSummary();
    }
  }

  function logMessage(msg, level = "info") {
    const timestamp = new Date().toLocaleTimeString();
    const line = document.createElement("div");
    line.className = "log-entry";

    let tagClass = "log-tag-info";
    let tagLabel = "[INFO]";
    if (level === "success") { tagClass = "log-tag-success"; tagLabel = "[OK]"; }
    else if (level === "warn") { tagClass = "log-tag-warn"; tagLabel = "[WARN]"; }
    else if (level === "error") { tagClass = "log-tag-error"; tagLabel = "[ERR]"; }

    line.innerHTML = `<span class="log-time">${timestamp}</span> <span class="${tagClass}">${tagLabel}</span> ${msg}`;
    logDrawer.appendChild(line);
    logDrawer.scrollTop = logDrawer.scrollHeight;
  }
});


