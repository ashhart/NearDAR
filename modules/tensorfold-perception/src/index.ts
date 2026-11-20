import { type EventSubscription, requireOptionalNativeModule } from 'expo-modules-core';

export type DepthState = 'unavailable' | 'starting' | 'ready' | 'stale' | 'limited' | 'lost';
export type Direction = 'ahead' | 'ahead-left' | 'ahead-right' | 'left' | 'right' | 'behind' | 'unknown';

export interface SessionOptions {
  /** Physical distance represented by one user step. No uncalibrated estimate is emitted. */
  stepLengthMeters?: number;
  warningDistanceMeters?: number;
  criticalDistanceMeters?: number;
  maximumFrameAgeMs?: number;
  maximumAlignmentAgeMs?: number;
  proximityIntervalMs?: number;
  detectPeople?: boolean;
  recognizeText?: boolean;
  ocrLanguages?: string[];
  /** Shared guidance fields consumed by voice and UI modules. */
  speechRate?: number;
  urgentHaptics?: boolean;
  speakerFallback?: boolean;
  onboardingComplete?: boolean;
}

export interface CaptureOptions {
  /** Defaults to true. Continuous proximity snapshots never contain images. */
  includeImage?: boolean;
  recognizeText?: boolean;
  detectPeople?: boolean;
  jpegQuality?: number;
}

export interface PerceptionCapabilities {
  available: boolean;
  depth: boolean;
  detector: boolean;
  ocr: boolean;
  reason?: string;
  platform?: 'ios' | 'android';
  cameraPermission?: 'granted' | 'denied' | 'notDetermined' | 'restricted' | 'unknown';
  depthSupportDetermined?: boolean;
  rawDepth?: boolean;
  meshClassification?: boolean;
  personDetection?: boolean;
  freeSeatCandidates?: boolean;
  limitations?: string[];
}

export interface SceneObject {
  id: string;
  label: string;
  confidence: number;
  direction: Direction;
  clockSector?: number;
  distanceMeters?: number;
  stepEstimate?: number;
  occupied?: boolean;
  evidence: string[];
}

export interface SeatCandidate extends SceneObject {
  free: boolean;
  occupancyConfidence: number;
}

export interface SceneWarning {
  id: string;
  kind: 'obstacle' | 'step-up' | 'step-down' | 'drop-off' | 'sensor';
  severity: 'info' | 'caution' | 'urgent';
  message: string;
  observedAt: number;
  distanceMeters?: number;
  direction?: Direction;
}

export interface PerceptionStatus {
  state: 'idle' | 'active' | 'degraded' | 'paused';
  active: boolean;
  capturing: boolean;
  trackingReady: boolean;
  depthState: DepthState;
  imageAvailable: boolean;
  observedAt?: number;
  lastCaptureAt?: number;
  message?: string;
}

export interface SceneSnapshot {
  observedAt: number;
  sequence: number;
  trackingReady: boolean;
  depthState: DepthState;
  validDepthFraction: number;
  cameraOrientation: 'calibrated-forward' | 'camera-forward' | 'unknown';
  objects: SceneObject[];
  freeSeats: SeatCandidate[];
  recognizedText: string[];
  textObservations?: { text: string; direction: Direction }[];
  imageBase64?: string;
  /** Owned temporary URI. Call releaseCapture after the vision engine finishes with it. */
  temporaryImagePath?: string;
  imageWidth?: number;
  imageHeight?: number;
  notes: string[];
}

export interface PerceptionEvent {
  type: 'snapshot' | 'warning' | 'status' | 'error' | 'lifecycle';
  snapshot?: SceneSnapshot;
  warning?: SceneWarning;
  message?: string;
  foreground?: boolean;
}

type NativePerception = {
  getCapabilities(): Promise<PerceptionCapabilities>;
  isForeground(): Promise<boolean>;
  startSession(options?: SessionOptions): Promise<void>;
  getStatus(): Promise<PerceptionStatus>;
  stopSession(): Promise<void>;
  captureScene(options?: CaptureOptions): Promise<SceneSnapshot>;
  releaseCapture(uri: string): Promise<{ released: boolean }>;
  addListener(eventName: string, listener: (event: PerceptionEvent) => void): void;
  removeListener(eventName: string, listener: (event: PerceptionEvent) => void): void;
};

const unavailableMessage = 'Camera perception requires the native iOS or Android app.';
const unavailable: NativePerception = {
  getCapabilities: async () => ({ available: false, depth: false, detector: false, ocr: false, reason: unavailableMessage }),
  isForeground: async () => false,
  startSession: async () => { throw new Error(unavailableMessage); },
  getStatus: async () => { throw new Error(unavailableMessage); },
  stopSession: async () => { throw new Error(unavailableMessage); },
  captureScene: async () => { throw new Error(unavailableMessage); },
  releaseCapture: async () => ({ released: false }),
  addListener: () => {},
  removeListener: () => {},
}
const native = requireOptionalNativeModule<NativePerception>('TensorFoldPerception') ?? unavailable;

export function getCapabilities(): Promise<PerceptionCapabilities> {
  return native.getCapabilities();
}

export function isForeground(): Promise<boolean> {
  return native.isForeground();
}

export function startSession(options: SessionOptions = {}): Promise<void> {
  validateOptions(options);
  return native.startSession(options);
}

export function getStatus(): Promise<PerceptionStatus> {
  return native.getStatus();
}

export function stopSession(): Promise<void> {
  return native.stopSession();
}

export function captureScene(options: CaptureOptions = {}): Promise<SceneSnapshot> {
  return native.captureScene(options);
}

export function releaseCapture(uri: string): Promise<{ released: boolean }> {
  if (!uri) return Promise.reject(new Error('A capture URI is required.'));
  return native.releaseCapture(uri);
}

export function addPerceptionListener(listener: (event: PerceptionEvent) => void): EventSubscription {
  native.addListener('onPerceptionEvent', listener);
  return { remove: () => native.removeListener('onPerceptionEvent', listener) };
}

function validateOptions(options: SessionOptions) {
  if (options.stepLengthMeters !== undefined && (options.stepLengthMeters < 0.3 || options.stepLengthMeters > 1.5)) {
    throw new Error('stepLengthMeters must be between 0.3 and 1.5.');
  }
  if (options.warningDistanceMeters !== undefined && options.warningDistanceMeters <= 0) {
    throw new Error('warningDistanceMeters must be positive.');
  }
  if (options.criticalDistanceMeters !== undefined && options.criticalDistanceMeters <= 0) {
    throw new Error('criticalDistanceMeters must be positive.');
  }
  if (
    options.warningDistanceMeters !== undefined &&
    options.criticalDistanceMeters !== undefined &&
    options.criticalDistanceMeters >= options.warningDistanceMeters
  ) {
    throw new Error('criticalDistanceMeters must be less than warningDistanceMeters.');
  }
}

export default native;
