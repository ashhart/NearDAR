import { NativeModule, requireOptionalNativeModule } from 'expo';
import type { EventSubscription } from 'expo-modules-core';

export type VoicePriority = 'ambient' | 'answer' | 'urgent';
export type AudioRoute = 'headphones' | 'speaker' | 'unknown';
export type VoiceEventType =
  | 'partial'
  | 'final'
  | 'listeningStarted'
  | 'listeningStopped'
  | 'speechStarted'
  | 'speechFinished'
  | 'speechStopped'
  | 'routeChanged'
  | 'error';
export type ListeningState =
  | 'requestingPermission'
  | 'starting'
  | 'listening'
  | 'speechStarted'
  | 'speechEnded'
  | 'stopped'
  | 'interrupted';
export type UtteranceState = 'queued' | 'started' | 'finished' | 'stopped' | 'error';

export interface ListeningOptions {
  /** BCP 47 locale. The selected locale must support on-device recognition. */
  locale?: string;
  /** End audio input after this much recognition inactivity. */
  silenceTimeoutMs?: number;
  /** Prefer a connected headset microphone. Defaults to true. */
  preferBluetoothMicrophone?: boolean;
}

export interface SpeakOptions {
  utteranceId?: string;
  /** BCP 47 locale. No network voice or missing-language fallback is used. */
  locale?: string;
  /** A voice identifier installed in system speech settings. */
  voiceIdentifier?: string;
  priority?: VoicePriority;
  /** Flush current and queued speech before this utterance. */
  interrupt?: boolean;
  /** Use the built-in speaker when no headset is connected. Defaults to true. */
  speakerFallback?: boolean;
  /** 0.25 through 2, relative to the platform's normal speech rate. */
  rate?: number;
  /** 0.5 through 2. */
  pitch?: number;
  /** 0 through 1. */
  volume?: number;
}

export interface AudioRoutePort {
  id: string;
  name: string;
  type: string;
  kind: string;
}

export interface AudioRouteSnapshot {
  reason: string;
  inputs: AudioRoutePort[];
  outputs: AudioRoutePort[];
  bluetoothMicrophoneAvailable: boolean;
  communicationDevice: string | null;
  timestamp: number;
}

export interface VoiceCapabilities {
  installedVoices?: { id: string; name: string; language: string }[];
  available: boolean;
  onDeviceRecognition: boolean;
  offlineSpeech: boolean;
  route: AudioRoute;
  reason?: string | null;
}

export interface VoiceEvent {
  type: VoiceEventType;
  timestamp: number;
  text?: string;
  message?: string | null;
  route?: AudioRoute;
  audioRoute?: AudioRouteSnapshot;
  sessionId?: string | null;
  utteranceId?: string | null;
  state?: ListeningState | UtteranceState;
  priority?: VoicePriority;
  confidence?: number | null;
  locale?: string;
  alternatives?: string[];
  operation?: string;
  code?: string;
}

export type VoiceEvents = {
  onVoiceEvent(event: VoiceEvent): void;
}

declare class TensorFoldVoiceNativeModule extends NativeModule<VoiceEvents> {
  getCapabilities(): Promise<VoiceCapabilities>;
  startListening(options?: ListeningOptions): Promise<{ sessionId: string; locale: string }>;
  downloadOfflineRecognition?(): Promise<'ready' | 'requested'>;
  stopListening(): Promise<void>;
  speak(text: string, options?: SpeakOptions): Promise<{
    utteranceId: string;
    voiceIdentifier: string;
    locale: string;
  }>;
  stopSpeaking(): Promise<void>;
}

class UnavailableVoiceNativeModule extends NativeModule<VoiceEvents> {
  getCapabilities(): Promise<VoiceCapabilities> {
    return Promise.resolve({
      available: false,
      onDeviceRecognition: false,
      offlineSpeech: false,
      route: 'unknown',
      reason: 'TensorFold Voice is unavailable on this platform. Use an iOS or Android development build.',
    });
  }

  private unavailable<T>(): Promise<T> {
    const error = new Error('TensorFold Voice requires the native iOS or Android module.') as Error & { code?: string };
    error.code = 'E_VOICE_UNAVAILABLE';
    return Promise.reject(error);
  }

  startListening(): Promise<{ sessionId: string; locale: string }> {
    return this.unavailable();
  }


  stopListening(): Promise<void> {
    return this.unavailable();
  }

  speak(): Promise<{ utteranceId: string; voiceIdentifier: string; locale: string }> {
    return this.unavailable();
  }

  stopSpeaking(): Promise<void> {
    return this.unavailable();
  }
}

const Voice: TensorFoldVoiceNativeModule =
  requireOptionalNativeModule<TensorFoldVoiceNativeModule>('TensorFoldVoice') ?? new UnavailableVoiceNativeModule();

export function getCapabilities(): Promise<VoiceCapabilities> {
  return Voice.getCapabilities();
}

export function startListening(options: ListeningOptions = {}): Promise<{ sessionId: string; locale: string }> {
  return Voice.startListening(options);
}

export function stopListening(): Promise<void> {
  return Voice.stopListening();
}

export function downloadOfflineRecognition(): Promise<'ready' | 'requested'> {
  return Voice.downloadOfflineRecognition?.() ??
    Promise.reject(new Error('Download offline speech in your phone’s speech settings.'));
}

export function speak(text: string, options: SpeakOptions = {}): Promise<{
  utteranceId: string;
  voiceIdentifier: string;
  locale: string;
}> {
  return Voice.speak(text, options);
}

export function stopSpeaking(): Promise<void> {
  return Voice.stopSpeaking();
}

export function addVoiceListener(listener: (event: VoiceEvent) => void): EventSubscription {
  Voice.addListener('onVoiceEvent', listener);
  return { remove: () => Voice.removeListener('onVoiceEvent', listener) };
}


// Explicit speak calls are the only source of synthesized guidance. This module
// never announces JS state through accessibility live regions or notification APIs.
export default Voice;
