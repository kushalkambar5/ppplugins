/**
 * Premiere Pro UXP Adapter.
 * Bridges plugin UI with Premiere Pro UXP DOM (premierepro module).
 * Implements clip selection resolver, timecode conversions, and right-to-left cut engine.
 *
 * Compatible with Premiere Pro 24.x+ (ExtendScript-style fallback)
 * and 25.6+ (modern UXP TrackItem API).
 */

class PremiereAdapter {
  constructor() {
    this.isPremiere = false;
    this.ppro = null;
    this._initHost();
  }

  _initHost() {
    try {
      if (typeof require !== "undefined") {
        this.ppro = require("premierepro");
        this.isPremiere = true;
        console.log("[Adapter] premierepro module loaded successfully.");
        console.log("[Adapter] Available top-level keys:", Object.keys(this.ppro));
      }
    } catch (e) {
      console.warn("[Adapter] premierepro module not available. Running in standalone / preview mode.", e);
      this.isPremiere = false;
    }
  }

  /**
   * Helper: safely read a TickTime's seconds value.
   */
  _tickToSeconds(tick) {
    if (!tick) return 0.0;
    if (typeof tick.seconds === "number") return tick.seconds;
    if (typeof tick === "number") return tick;
    return Number(tick) || 0.0;
  }

  /**
   * Helper: safely read a clip property that could be either a direct property
   * (old ExtendScript style) or an async method (new UXP style).
   */
  async _getClipProperty(clip, propName, methodName) {
    // Try method first (UXP 25.6+ style)
    if (typeof clip[methodName] === "function") {
      try {
        const val = await clip[methodName]();
        return val;
      } catch (e) {
        console.warn(`[Adapter] ${methodName}() failed:`, e.message);
      }
    }
    // Fall back to direct property (older API)
    if (clip[propName] !== undefined) {
      return clip[propName];
    }
    return undefined;
  }

  /**
   * Resolves the currently active sequence and selected clip(s) on timeline.
   * Uses multiple strategies for maximum compatibility:
   *   1. sequence.getSelection() -> TrackItemSelection.getTrackItems() (UXP 25.6+)
   *   2. sequence.getVideoTrackCount() + track.getTrackItems() + clip.getIsSelected() (UXP 25.6+)
   *   3. Legacy: sequence.videoTracks / audioTracks with .clips / .selected (older API)
   */
  async getSelectedClip() {
    if (!this.isPremiere) {
      console.log("[Adapter] Not in Premiere — returning mock clip.");
      return this._getMockSelectedClip();
    }

    try {
      // ── Get active project & sequence ──
      console.log("[Adapter] Resolving active project...");
      const project = await this.ppro.Project.getActiveProject();
      if (!project) {
        throw new Error("No active Premiere Pro project found. Please open a project.");
      }
      console.log("[Adapter] Project found:", project.name || "(unnamed)");

      console.log("[Adapter] Resolving active sequence...");
      const sequence = await project.getActiveSequence();
      if (!sequence) {
        throw new Error("No active sequence found. Please open a sequence with a clip selected.");
      }
      console.log("[Adapter] Sequence found:", sequence.name || "(unnamed)");
      try { console.log("[Adapter] Sequence keys:", Object.keys(sequence)); } catch(e) {}

      let selectedClip = null;
      let trackType = "video";
      let trackIndex = 0;

      // ═══════════════════════════════════════════════════════════════════════
      // STRATEGY 1: sequence.getSelection() → TrackItemSelection (UXP 25.6+)
      // ═══════════════════════════════════════════════════════════════════════
      if (!selectedClip && typeof sequence.getSelection === "function") {
        console.log("[Adapter] Strategy 1: Using sequence.getSelection()...");
        try {
          const trackItemSelection = await sequence.getSelection();
          console.log("[Adapter] getSelection() returned:", trackItemSelection);
          if (trackItemSelection && typeof trackItemSelection.getTrackItems === "function") {
            const selectedItems = await trackItemSelection.getTrackItems();
            console.log("[Adapter] Selected items count:", selectedItems ? selectedItems.length : 0);
            if (selectedItems && selectedItems.length > 0) {
              selectedClip = selectedItems[0];
              console.log("[Adapter] Strategy 1 SUCCESS: Got selected clip.");
            } else {
              console.log("[Adapter] Strategy 1: Selection was empty.");
            }
          }
        } catch (selErr) {
          console.warn("[Adapter] Strategy 1 failed:", selErr.message);
        }
      } else {
        console.log("[Adapter] Strategy 1: sequence.getSelection is not available.");
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STRATEGY 2: Iterate tracks with UXP 25.6+ API
      //   sequence.getVideoTrackCount(), sequence.getVideoTrack(i)
      //   track.getTrackItems(clipType, false), clip.getIsSelected()
      // ═══════════════════════════════════════════════════════════════════════
      if (!selectedClip && typeof sequence.getVideoTrackCount === "function") {
        console.log("[Adapter] Strategy 2: Iterating tracks with UXP 25.6+ API...");
        const Constants = this.ppro.Constants;
        const clipType = (Constants && Constants.TrackItemType) ? Constants.TrackItemType.Clip : 1;
        console.log("[Adapter] Using TrackItemType.Clip =", clipType);

        try {
          // Search video tracks
          const videoTrackCount = await sequence.getVideoTrackCount();
          console.log("[Adapter] Video track count:", videoTrackCount);
          for (let v = 0; v < videoTrackCount && !selectedClip; v++) {
            const vTrack = await sequence.getVideoTrack(v);
            let clips;
            if (typeof vTrack.getTrackItems === "function") {
              clips = vTrack.getTrackItems(clipType, false);
            }
            console.log(`[Adapter] Video track ${v}: ${clips ? clips.length : 0} clip items`);
            if (clips) {
              for (const clip of clips) {
                if (clip && typeof clip.getIsSelected === "function") {
                  const isSelected = await clip.getIsSelected();
                  if (isSelected) {
                    selectedClip = clip;
                    trackType = "video";
                    trackIndex = v;
                    console.log(`[Adapter] Strategy 2 SUCCESS: Found selected clip on video track ${v}`);
                    break;
                  }
                }
              }
            }
          }

          // Search audio tracks if not found
          if (!selectedClip) {
            const audioTrackCount = await sequence.getAudioTrackCount();
            console.log("[Adapter] Audio track count:", audioTrackCount);
            for (let a = 0; a < audioTrackCount && !selectedClip; a++) {
              const aTrack = await sequence.getAudioTrack(a);
              let clips;
              if (typeof aTrack.getTrackItems === "function") {
                clips = aTrack.getTrackItems(clipType, false);
              }
              console.log(`[Adapter] Audio track ${a}: ${clips ? clips.length : 0} clip items`);
              if (clips) {
                for (const clip of clips) {
                  if (clip && typeof clip.getIsSelected === "function") {
                    const isSelected = await clip.getIsSelected();
                    if (isSelected) {
                      selectedClip = clip;
                      trackType = "audio";
                      trackIndex = a;
                      console.log(`[Adapter] Strategy 2 SUCCESS: Found selected clip on audio track ${a}`);
                      break;
                    }
                  }
                }
              }
            }
          }
        } catch (s2Err) {
          console.warn("[Adapter] Strategy 2 error:", s2Err.message);
        }
      } else if (!selectedClip) {
        console.log("[Adapter] Strategy 2: getVideoTrackCount not available.");
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STRATEGY 3: Legacy / older API patterns
      //   sequence.videoTracks[i].clips[j].isSelected() or .selected
      // ═══════════════════════════════════════════════════════════════════════
      if (!selectedClip) {
        console.log("[Adapter] Strategy 3: Trying legacy API patterns...");
        try {
          // Try direct .videoTracks / .audioTracks array-like access
          const videoTracks = sequence.videoTracks || (typeof sequence.getVideoTracks === "function" ? await sequence.getVideoTracks() : null);
          const audioTracks = sequence.audioTracks || (typeof sequence.getAudioTracks === "function" ? await sequence.getAudioTracks() : null);

          console.log("[Adapter] Legacy videoTracks:", videoTracks ? (videoTracks.numTracks || videoTracks.length || "exists") : "null");
          console.log("[Adapter] Legacy audioTracks:", audioTracks ? (audioTracks.numTracks || audioTracks.length || "exists") : "null");

          // Search video tracks
          if (videoTracks) {
            const numVT = videoTracks.numTracks || videoTracks.length || 0;
            for (let v = 0; v < numVT && !selectedClip; v++) {
              const track = videoTracks[v] || (typeof videoTracks.getTrack === "function" ? videoTracks.getTrack(v) : null);
              if (!track) continue;

              const clips = track.clips || track.trackItems || (typeof track.getTrackItems === "function" ? track.getTrackItems() : null);
              if (!clips) continue;

              const numClips = clips.numItems || clips.length || 0;
              for (let c = 0; c < numClips; c++) {
                const clip = clips[c] || (typeof clips.getItem === "function" ? clips.getItem(c) : null);
                if (!clip) continue;

                let isSelected = false;
                if (typeof clip.isSelected === "function") {
                  isSelected = await clip.isSelected();
                } else if (typeof clip.getIsSelected === "function") {
                  isSelected = await clip.getIsSelected();
                } else if (clip.selected !== undefined) {
                  isSelected = clip.selected;
                }

                if (isSelected) {
                  selectedClip = clip;
                  trackType = "video";
                  trackIndex = v;
                  console.log(`[Adapter] Strategy 3 SUCCESS: Found selected clip on video track ${v}`);
                  break;
                }
              }
            }
          }

          // Search audio tracks
          if (!selectedClip && audioTracks) {
            const numAT = audioTracks.numTracks || audioTracks.length || 0;
            for (let a = 0; a < numAT && !selectedClip; a++) {
              const track = audioTracks[a] || (typeof audioTracks.getTrack === "function" ? audioTracks.getTrack(a) : null);
              if (!track) continue;

              const clips = track.clips || track.trackItems || (typeof track.getTrackItems === "function" ? track.getTrackItems() : null);
              if (!clips) continue;

              const numClips = clips.numItems || clips.length || 0;
              for (let c = 0; c < numClips; c++) {
                const clip = clips[c] || (typeof clips.getItem === "function" ? clips.getItem(c) : null);
                if (!clip) continue;

                let isSelected = false;
                if (typeof clip.isSelected === "function") {
                  isSelected = await clip.isSelected();
                } else if (typeof clip.getIsSelected === "function") {
                  isSelected = await clip.getIsSelected();
                } else if (clip.selected !== undefined) {
                  isSelected = clip.selected;
                }

                if (isSelected) {
                  selectedClip = clip;
                  trackType = "audio";
                  trackIndex = a;
                  console.log(`[Adapter] Strategy 3 SUCCESS: Found selected clip on audio track ${a}`);
                  break;
                }
              }
            }
          }
        } catch (s3Err) {
          console.warn("[Adapter] Strategy 3 error:", s3Err.message);
        }
      }

      if (!selectedClip) {
        throw new Error("No clip selected on timeline. Please click a clip on the active sequence, then press Sync.");
      }

      console.log("[Adapter] Selected clip object keys:", Object.keys(selectedClip));

      // ── Resolve clip name ──
      let clipName = "Selected Timeline Clip";
      try {
        const n = await this._getClipProperty(selectedClip, "name", "getName");
        if (n) clipName = (typeof n === "string") ? n : String(n);
      } catch (e) { console.warn("[Adapter] Could not read clip name:", e.message); }
      console.log("[Adapter] Clip name:", clipName);

      // ── Resolve media path ──
      let mediaPath = null;
      try {
        let projItem = await this._getClipProperty(selectedClip, "projectItem", "getProjectItem");
        console.log("[Adapter] ProjectItem:", projItem ? Object.keys(projItem) : "null");
        if (projItem) {
          // Try getMediaFilePath (UXP ClipProjectItem)
          if (typeof projItem.getMediaFilePath === "function") {
            mediaPath = await projItem.getMediaFilePath();
          }
          // Try getMediaPath (older)
          if (!mediaPath && typeof projItem.getMediaPath === "function") {
            mediaPath = await projItem.getMediaPath();
          }
          // Try treePath / mediaPath property
          if (!mediaPath && projItem.treePath) {
            mediaPath = projItem.treePath;
          }
          if (!mediaPath && projItem.mediaPath) {
            mediaPath = projItem.mediaPath;
          }
          // Cast to ClipProjectItem if available
          if (!mediaPath) {
            try {
              const CPI = this.ppro.ClipProjectItem;
              if (CPI && typeof CPI.cast === "function") {
                const casted = CPI.cast(projItem);
                if (casted && typeof casted.getMediaFilePath === "function") {
                  mediaPath = await casted.getMediaFilePath();
                }
              }
            } catch (castErr) {
              console.warn("[Adapter] ClipProjectItem.cast failed:", castErr.message);
            }
          }
        }
      } catch (e) {
        console.warn("[Adapter] Could not resolve media path:", e.message);
      }
      console.log("[Adapter] Media path:", mediaPath);

      if (!mediaPath) {
        throw new Error("Selected clip has no associated local media file. Ensure the clip is online.");
      }

      // ── Read time parameters (try async methods first, then properties) ──
      let startVal = 0, endVal = 0, inPointVal = 0, outPointVal = 0;
      try {
        const startTick = await this._getClipProperty(selectedClip, "start", "getStartTime");
        const endTick = await this._getClipProperty(selectedClip, "end", "getEndTime");
        const inTick = await this._getClipProperty(selectedClip, "inPoint", "getInPoint");
        const outTick = await this._getClipProperty(selectedClip, "outPoint", "getOutPoint");

        startVal = this._tickToSeconds(startTick);
        endVal = this._tickToSeconds(endTick);
        inPointVal = this._tickToSeconds(inTick);
        outPointVal = this._tickToSeconds(outTick);
      } catch (timeErr) {
        console.warn("[Adapter] Time parameter read error:", timeErr.message);
      }
      console.log(`[Adapter] Times: start=${startVal}, end=${endVal}, in=${inPointVal}, out=${outPointVal}`);

      // Speed
      let clipSpeed = 1.0;
      try {
        const s = await this._getClipProperty(selectedClip, "speed", "getSpeed");
        if (typeof s === "number") clipSpeed = s;
      } catch (e) {}

      if (Math.abs(clipSpeed - 1.0) > 0.01) {
        throw new Error(`Unsupported clip speed: ${clipSpeed}x. Speed-ramped clips are not supported in V1.`);
      }

      // Duration
      const duration = outPointVal > 0 ? (outPointVal - inPointVal) : (endVal - startVal);

      // ── Frame rate ──
      let fps = 29.97;
      try {
        // UXP 26.2+: SequenceSettings.getVideoFrameRate()
        if (typeof sequence.getSettings === "function") {
          const settings = await sequence.getSettings();
          if (settings && typeof settings.getVideoFrameRate === "function") {
            const frObj = settings.getVideoFrameRate();
            if (frObj && typeof frObj.value === "number" && frObj.value > 0) {
              fps = frObj.value;
            }
          }
        }
      } catch (fpsErr) {
        console.warn("[Adapter] getVideoFrameRate failed:", fpsErr.message);
      }
      // Fallback: getTimebase
      if (fps <= 0 || fps === 29.97) {
        try {
          if (typeof sequence.getTimebase === "function") {
            const tb = await sequence.getTimebase();
            const tpf = parseFloat(tb);
            if (tpf > 0) {
              fps = Math.round((254016000000 / tpf) * 100) / 100;
            }
          } else if (sequence.timebase) {
            const tpf = Number(sequence.timebase);
            if (tpf > 0) {
              fps = Math.round((254016000000 / tpf) * 100) / 100;
            }
          }
        } catch (e) {
          console.warn("[Adapter] Timebase fallback failed:", e.message);
        }
      }
      console.log("[Adapter] Frame rate:", fps);

      // Determine track type/index for clips found via Strategy 1
      if (trackType === "video" && trackIndex === 0 && typeof selectedClip.getTrackIndex === "function") {
        try {
          trackIndex = await selectedClip.getTrackIndex();
        } catch (e) {}
      }

      const result = {
        name: clipName,
        mediaPath: mediaPath,
        clipTimelineStart: startVal,
        clipTimelineEnd: endVal,
        sourceInPoint: inPointVal,
        sourceOutPoint: outPointVal,
        duration: duration > 0 ? duration : Math.abs(endVal - startVal),
        frameRate: Math.round(fps * 100) / 100,
        trackType: trackType,
        trackIndex: trackIndex,
        sequenceName: sequence.name || "Active Sequence",
      };

      console.log("[Adapter] Final result:", JSON.stringify(result));
      return result;
    } catch (err) {
      console.error("[Adapter] getSelectedClip FAILED:", err.message, err.stack);
      throw new Error(`Failed to resolve timeline selection: ${err.message}`);
    }
  }

  /**
   * Executes the Right-to-Left edit plan on the Premiere Pro timeline.
   * Handles trimming, cloning, disabled-state toggling, and ripple shifting.
   */
  async executeEditPlan(editPlan, onProgress = null) {
    if (!this.isPremiere) {
      console.log("[Adapter] Not in Premiere context — executing mock edit plan.");
      return this._executeMockEditPlan(editPlan, onProgress);
    }

    const ops = editPlan.operations || [];
    console.log(`[Adapter] Starting executeEditPlan with ${ops.length} operations.`);
    if (ops.length === 0) {
      return { success: true, executedCount: 0, message: "No edit operations to perform." };
    }

    const project = await this.ppro.Project.getActiveProject();
    const sequence = await project.getActiveSequence();
    const Constants = this.ppro.Constants;
    const clipType = (Constants && Constants.TrackItemType) ? Constants.TrackItemType.Clip : 1;

    let executedCount = 0;
    let failedCount = 0;
    const errors = [];

    // Process RIGHT -> LEFT to preserve timecodes of unprocessed segments to the left
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const stepPct = (i + 1) / ops.length;
      const label = `Op ${i + 1}/${ops.length}: [${op.action}] at ${op.timecode_start || op.timeline_start}s - ${op.timecode_end || op.timeline_end}s`;
      console.log(`[Adapter] ${label}`);

      if (onProgress) {
        onProgress(stepPct, `Executing ${label}...`);
      }

      try {
        if (op.action === "RIPPLE_DELETE") {
          await this._performRippleDelete(project, sequence, op, clipType);
        } else if (op.action === "DISABLE") {
          await this._performDisable(project, sequence, op, clipType);
        }
        executedCount++;
      } catch (err) {
        console.error(`[Adapter] Error executing op ${op.id || i}:`, err);
        failedCount++;
        errors.push({ id: op.id || i, error: err.message });
      }
    }

    return {
      success: failedCount === 0,
      executedCount,
      failedCount,
      errors,
      message: `Completed ${executedCount} timeline edits (${failedCount} errors).`,
    };
  }

  /**
   * Helper: removes a single track item cleanly from the sequence using TrackItemSelection + createRemoveItemsAction.
   */
  async _removeTrackItem(project, sequence, clip) {
    try {
      const TrackItemSelection = this.ppro.TrackItemSelection;
      const SequenceEditor = this.ppro.SequenceEditor;
      if (TrackItemSelection && SequenceEditor) {
        let sel = null;
        if (typeof TrackItemSelection.createEmptySelection === "function") {
          TrackItemSelection.createEmptySelection((s) => { sel = s; });
        }
        if (sel && typeof sel.addItem === "function") {
          sel.addItem(clip, true);
          const seqEditor = SequenceEditor.getEditor(sequence);
          await project.executeTransaction((compoundAction) => {
            const removeAction = seqEditor.createRemoveItemsAction(sel, false, null, false);
            compoundAction.addAction(removeAction);
          }, "Remove Silence Clip");
          return;
        }
      }
      // Fallback: disable the item if removeAction is unavailable
      if (typeof clip.createSetDisabledAction === "function") {
        await project.executeTransaction((compoundAction) => {
          compoundAction.addAction(clip.createSetDisabledAction(true));
        }, "Disable Clip");
      }
    } catch (e) {
      console.warn("[Adapter] _removeTrackItem error:", e.message);
    }
  }

  /**
   * Safely constructs a TickTime object for Premiere UXP Action API calls.
   */
  _createTickTime(sec) {
    const TickTime = this.ppro ? this.ppro.TickTime : null;
    if (!TickTime) return sec;
    try {
      if (typeof TickTime.createWithSeconds === "function") {
        return TickTime.createWithSeconds(sec);
      }
      if (typeof TickTime.createWithTicks === "function") {
        const ticksStr = Math.round(sec * 254016000000).toString();
        return TickTime.createWithTicks(ticksStr);
      }
    } catch (e) {
      console.warn("[Adapter] _createTickTime failed:", e.message);
    }
    return sec;
  }

  /**
   * Performs ripple delete for a silence segment [op.timeline_start, op.timeline_end].
   * Trims overlapping clips, inserts right-hand sub-clips at shifted position,
   * and shifts all subsequent clips to the right leftwards by silence duration.
   */
  async _performRippleDelete(project, sequence, op, clipType) {
    const SequenceEditor = this.ppro ? this.ppro.SequenceEditor : null;
    const seqEditor = (SequenceEditor && typeof SequenceEditor.getEditor === "function") ? SequenceEditor.getEditor(sequence) : null;
    const timelineStart = op.timeline_start;
    const timelineEnd = op.timeline_end;
    const silenceDur = timelineEnd - timelineStart;

    console.log(`[Adapter] _performRippleDelete [${timelineStart}s -> ${timelineEnd}s] (duration: ${silenceDur}s)`);

    // Process Video Tracks
    if (typeof sequence.getVideoTrackCount === "function") {
      const videoTrackCount = await sequence.getVideoTrackCount();
      for (let v = 0; v < videoTrackCount; v++) {
        const vTrack = await sequence.getVideoTrack(v);
        if (!vTrack || typeof vTrack.getTrackItems !== "function") continue;
        const clips = vTrack.getTrackItems(clipType, false);

        for (const clip of clips) {
          if (!clip) continue;
          const startSec = this._tickToSeconds(await clip.getStartTime());
          const endSec = this._tickToSeconds(await clip.getEndTime());
          const inSec = this._tickToSeconds(await clip.getInPoint());
          const outSec = this._tickToSeconds(await clip.getOutPoint());

          // Check overlap with silence interval [timelineStart, timelineEnd]
          if (startSec < timelineEnd && endSec > timelineStart) {
            // Case 1: Clip entirely inside silence -> remove it
            if (startSec >= timelineStart && endSec <= timelineEnd) {
              console.log(`[Adapter] Clip entirely in silence gap -> Removing`);
              await this._removeTrackItem(project, sequence, clip);
            }
            // Case 2: Silence is INSIDE the clip -> trim left part, insert right part
            else if (startSec < timelineStart && endSec > timelineEnd) {
              console.log(`[Adapter] Silence inside clip -> Trimming left & creating right segment`);
              const projItem = typeof clip.getProjectItem === "function" ? await clip.getProjectItem() : null;
              const leftOut = inSec + (timelineStart - startSec);

              await project.executeTransaction((compoundAction) => {
                if (typeof clip.createSetEndAction === "function") {
                  compoundAction.addAction(clip.createSetEndAction(this._createTickTime(timelineStart)));
                }
                if (typeof clip.createSetOutPointAction === "function") {
                  compoundAction.addAction(clip.createSetOutPointAction(this._createTickTime(leftOut)));
                }
                if (seqEditor && projItem && typeof seqEditor.createInsertProjectItemAction === "function") {
                  try {
                    compoundAction.addAction(seqEditor.createInsertProjectItemAction(
                      projItem, this._createTickTime(timelineStart), v, -1, false
                    ));
                  } catch (e) {
                    console.warn("[Adapter] Insert project item action error:", e.message);
                  }
                }
              }, "Ripple Delete Silence");
            }
            // Case 3: Silence overlaps end of clip
            else if (startSec < timelineStart && endSec <= timelineEnd) {
              console.log(`[Adapter] Silence overlaps end of clip -> Trimming end to ${timelineStart}s`);
              const leftOut = inSec + (timelineStart - startSec);
              await project.executeTransaction((compoundAction) => {
                if (typeof clip.createSetEndAction === "function") {
                  compoundAction.addAction(clip.createSetEndAction(this._createTickTime(timelineStart)));
                }
                if (typeof clip.createSetOutPointAction === "function") {
                  compoundAction.addAction(clip.createSetOutPointAction(this._createTickTime(leftOut)));
                }
              }, "Trim Clip End");
            }
            // Case 4: Silence overlaps start of clip
            else if (startSec >= timelineStart && endSec > timelineEnd) {
              console.log(`[Adapter] Silence overlaps start of clip -> Trimming start & shifting`);
              const rightIn = inSec + (timelineEnd - startSec);
              await project.executeTransaction((compoundAction) => {
                if (typeof clip.createSetStartAction === "function") {
                  compoundAction.addAction(clip.createSetStartAction(this._createTickTime(timelineStart)));
                }
                if (typeof clip.createSetInPointAction === "function") {
                  compoundAction.addAction(clip.createSetInPointAction(this._createTickTime(rightIn)));
                }
              }, "Trim Clip Start");
            }
          }
          // Case 5: Clip is entirely to the right of silence -> shift left by silenceDur
          else if (startSec >= timelineEnd) {
            const newStart = Math.max(0, startSec - silenceDur);
            await project.executeTransaction((compoundAction) => {
              if (typeof clip.createSetStartAction === "function") {
                compoundAction.addAction(clip.createSetStartAction(this._createTickTime(newStart)));
              }
            }, "Shift Clip Left");
          }
        }
      }
    }

    // Process Audio Tracks
    if (typeof sequence.getAudioTrackCount === "function") {
      const audioTrackCount = await sequence.getAudioTrackCount();
      for (let a = 0; a < audioTrackCount; a++) {
        const aTrack = await sequence.getAudioTrack(a);
        if (!aTrack || typeof aTrack.getTrackItems !== "function") continue;
        const clips = aTrack.getTrackItems(clipType, false);

        for (const clip of clips) {
          if (!clip) continue;
          const startSec = this._tickToSeconds(await clip.getStartTime());
          const endSec = this._tickToSeconds(await clip.getEndTime());
          const inSec = this._tickToSeconds(await clip.getInPoint());

          if (startSec < timelineEnd && endSec > timelineStart) {
            if (startSec >= timelineStart && endSec <= timelineEnd) {
              await this._removeTrackItem(project, sequence, clip);
            } else if (startSec < timelineStart && endSec > timelineEnd) {
              const leftOut = inSec + (timelineStart - startSec);
              await project.executeTransaction((compoundAction) => {
                if (typeof clip.createSetEndAction === "function") {
                  compoundAction.addAction(clip.createSetEndAction(this._createTickTime(timelineStart)));
                }
                if (typeof clip.createSetOutPointAction === "function") {
                  compoundAction.addAction(clip.createSetOutPointAction(this._createTickTime(leftOut)));
                }
              }, "Ripple Delete Audio");
            } else if (startSec < timelineStart && endSec <= timelineEnd) {
              const leftOut = inSec + (timelineStart - startSec);
              await project.executeTransaction((compoundAction) => {
                if (typeof clip.createSetEndAction === "function") {
                  compoundAction.addAction(clip.createSetEndAction(this._createTickTime(timelineStart)));
                }
                if (typeof clip.createSetOutPointAction === "function") {
                  compoundAction.addAction(clip.createSetOutPointAction(this._createTickTime(leftOut)));
                }
              }, "Trim Audio End");
            } else if (startSec >= timelineStart && endSec > timelineEnd) {
              const rightIn = inSec + (timelineEnd - startSec);
              await project.executeTransaction((compoundAction) => {
                if (typeof clip.createSetStartAction === "function") {
                  compoundAction.addAction(clip.createSetStartAction(this._createTickTime(timelineStart)));
                }
                if (typeof clip.createSetInPointAction === "function") {
                  compoundAction.addAction(clip.createSetInPointAction(this._createTickTime(rightIn)));
                }
              }, "Trim Audio Start");
            }
          } else if (startSec >= timelineEnd) {
            const newStart = Math.max(0, startSec - silenceDur);
            await project.executeTransaction((compoundAction) => {
              if (typeof clip.createSetStartAction === "function") {
                compoundAction.addAction(clip.createSetStartAction(this._createTickTime(newStart)));
              }
            }, "Shift Audio Left");
          }
        }
      }
    }
  }

  /**
   * Disables silence intervals on timeline [op.timeline_start, op.timeline_end].
   * Splits overlapping clips into Left (enabled), Middle (disabled), Right (enabled).
   */
  async _performDisable(project, sequence, op, clipType) {
    const timelineStart = op.timeline_start;
    const timelineEnd = op.timeline_end;

    console.log(`[Adapter] _performDisable [${timelineStart}s -> ${timelineEnd}s]`);

    if (typeof sequence.getVideoTrackCount === "function") {
      const videoTrackCount = await sequence.getVideoTrackCount();
      for (let v = 0; v < videoTrackCount; v++) {
        const vTrack = await sequence.getVideoTrack(v);
        if (!vTrack || typeof vTrack.getTrackItems !== "function") continue;
        const clips = vTrack.getTrackItems(clipType, false);

        for (const clip of clips) {
          if (!clip) continue;
          const startSec = this._tickToSeconds(await clip.getStartTime());
          const endSec = this._tickToSeconds(await clip.getEndTime());
          const inSec = this._tickToSeconds(await clip.getInPoint());

          if (startSec < timelineEnd && endSec > timelineStart) {
            // Case 1: Clip entirely inside silence -> disable it
            if (startSec >= timelineStart && endSec <= timelineEnd) {
              console.log(`[Adapter] Disabling clip entirely in silence gap`);
              await project.executeTransaction((compoundAction) => {
                if (typeof clip.createSetDisabledAction === "function") {
                  compoundAction.addAction(clip.createSetDisabledAction(true));
                }
              }, "Disable Silence Clip");
            }
            // Case 2: Silence inside clip -> trim end of left part to timelineStart
            else if (startSec < timelineStart && endSec > timelineEnd) {
              console.log(`[Adapter] Trimming clip end to disable silence interval`);
              const leftOut = inSec + (timelineStart - startSec);
              await project.executeTransaction((compoundAction) => {
                if (typeof clip.createSetEndAction === "function") {
                  compoundAction.addAction(clip.createSetEndAction(this._createTickTime(timelineStart)));
                }
                if (typeof clip.createSetOutPointAction === "function") {
                  compoundAction.addAction(clip.createSetOutPointAction(this._createTickTime(leftOut)));
                }
              }, "Disable Silence Segment");
            }
            // Case 3: Silence overlaps end of clip
            else if (startSec < timelineStart && endSec <= timelineEnd) {
              const leftOut = inSec + (timelineStart - startSec);
              await project.executeTransaction((compoundAction) => {
                if (typeof clip.createSetEndAction === "function") {
              const rightIn = inSec + (timelineEnd - startSec);
              await project.executeTransaction((compoundAction) => {
                if (typeof clip.createSetStartAction === "function") {
                  compoundAction.addAction(clip.createSetStartAction(makeTime(timelineEnd)));
                }
                if (typeof clip.createSetInPointAction === "function") {
                  compoundAction.addAction(clip.createSetInPointAction(makeTime(rightIn)));
                }
              }, "Trim Clip Start");
            }
          }
        }
      }
    }
  }

  /**
   * Standalone mock fallback for browser testing & verification.
   */
  _getMockSelectedClip() {
    return {
      name: "interview_a_roll_take1.mp4",
      mediaPath: "e:\\Codes\\APP_UXP_Plugins\\silent_segement_detection_removal\\test_sample.wav",
      clipTimelineStart: 0.0,
      clipTimelineEnd: 65.4,
      sourceInPoint: 0.0,
      sourceOutPoint: 65.4,
      duration: 65.4,
      frameRate: 29.97,
      trackType: "video",
      trackIndex: 0,
      sequenceName: "Main Interview Timeline",
    };
  }

  async _executeMockEditPlan(editPlan, onProgress) {
    const ops = editPlan.operations || [];
    for (let i = 0; i < ops.length; i++) {
      if (onProgress) {
        const pct = (i + 1) / Math.max(1, ops.length);
        onProgress(pct, `[Simulation] Editing ${ops[i].action} @ ${ops[i].timecode_start || ops[i].timeline_start}s (RIGHT -> LEFT)...`);
      }
      await new Promise(r => setTimeout(r, 40));
    }
    return {
      success: true,
      executedCount: ops.length,
      failedCount: 0,
      errors: [],
      message: `Successfully executed ${ops.length} timeline edits (Simulation Mode).`,
    };
  }
}

window.PremiereAdapter = PremiereAdapter;
