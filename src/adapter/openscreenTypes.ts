/**
 * The subset of OpenScreen's project + cursor types that the adapter emits.
 *
 * Mirrored from OpenScreen:
 *  - EditorProjectData / ProjectEditorState:
 *      src/components/video-editor/projectPersistence.ts
 *  - ZoomRegion / ZoomFocus / SpeedRegion / CursorTelemetryPoint:
 *      src/components/video-editor/types.ts
 *  - CursorRecordingData / CursorRecordingSample (the `<video>.cursor.json` sidecar):
 *      src/native/contracts.ts  (read back by electron/ipc/handlers.ts:readCursorRecordingFile)
 *
 * Keep these in sync with OpenScreen. They are intentionally structural
 * (no imports from OpenScreen) so SupaVideo can build standalone.
 */

export type NativeCursorType =
  | "arrow"
  | "text"
  | "pointer"
  | "crosshair"
  | "open-hand"
  | "closed-hand"
  | "resize-ew"
  | "resize-ns"
  | "not-allowed";

/** One sample in the `<video>.cursor.json` sidecar OpenScreen reads at export. */
export interface CursorRecordingSample {
  timeMs: number;
  cx: number; // video-pixel space
  cy: number; // video-pixel space
  assetId?: string | null;
  visible?: boolean;
  cursorType?: NativeCursorType | null;
  interactionType?: "move" | "click" | "mouseup";
}

export interface NativeCursorAsset {
  id: string;
  platform: "darwin" | "win32" | "linux";
  imageDataUrl: string;
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  scaleFactor?: number;
  cursorType?: NativeCursorType | null;
}

/** Contents of `<videoPath>.cursor.json`. */
export interface CursorRecordingData {
  version: number;
  provider: "native" | "none";
  samples: CursorRecordingSample[];
  assets: NativeCursorAsset[];
}

export interface ZoomFocus {
  cx: number; // normalized 0-1
  cy: number; // normalized 0-1
}

export type ZoomDepth = 1 | 2 | 3 | 4 | 5 | 6;

export interface ZoomRegion {
  id: string;
  startMs: number;
  endMs: number;
  depth: ZoomDepth;
  focus: ZoomFocus;
  focusMode?: "manual" | "auto";
  customScale?: number;
}

export interface SpeedRegion {
  id: string;
  startMs: number;
  endMs: number;
  speed: number;
}

export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:3" | "4:5" | "16:10" | "10:16" | "native";

/** ProjectEditorState — the editable part of an OpenScreen project. */
export interface ProjectEditorState {
  wallpaper: string;
  shadowIntensity: number;
  showBlur: boolean;
  showTrimWaveform: boolean;
  motionBlurAmount: number;
  borderRadius: number;
  padding: number;
  cropRegion: { x: number; y: number; width: number; height: number };
  zoomRegions: ZoomRegion[];
  trimRegions: Array<{ id: string; startMs: number; endMs: number }>;
  speedRegions: SpeedRegion[];
  annotationRegions: unknown[];
  aspectRatio: AspectRatio;
  webcamLayoutPreset: string;
  webcamMaskShape: string;
  webcamSizePreset: number;
  webcamPosition: { cx: number; cy: number } | null;
  exportQuality: "good" | "medium" | "source";
  exportFormat: "mp4" | "gif";
  gifFrameRate: number;
  gifLoop: boolean;
  gifSizePreset: string;
}

export interface EditorProjectData {
  version: number;
  editor: ProjectEditorState;
  videoPath?: string;
}
