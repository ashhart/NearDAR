import type { EngineCapabilities, EngineStatus, GuidanceSettings, SceneSnapshot, SceneWarning, VoiceCapabilities } from './types'

export interface EngineGenerationRequest {
  requestId: string
  prompt: string
  system: string
  question: string
  maxTokens: number
  temperature: number
  imageBase64?: string
  temporaryImagePath?: string
}

export interface PerceptionModule {
  getCapabilities(): Promise<{ available: boolean; depth: boolean; detector: boolean; ocr: boolean; reason?: string }>
  startSession(settings: GuidanceSettings): Promise<void>
  stopSession(): Promise<void>
  captureScene(): Promise<SceneSnapshot>
  addListener?(listener: (event: { type: string; snapshot?: SceneSnapshot; warning?: SceneWarning; message?: string }) => void): { remove(): void }
}

export interface EngineModule {
  getCapabilities(): Promise<EngineCapabilities>
  getStatus(): Promise<EngineStatus>
  installModel(modelId?: string): Promise<EngineStatus>
  loadModel(installationId?: string): Promise<EngineStatus>
  unloadModel(): Promise<void>
  generate(request: EngineGenerationRequest): Promise<string>
  cancel(requestId: string): Promise<void>
  addListener?(listener: (event: { type: string; status?: EngineStatus; requestId?: string; token?: string; message?: string }) => void): { remove(): void }
}

export interface VoiceModule {
  getCapabilities(): Promise<VoiceCapabilities>
  startListening(): Promise<void>
  stopListening(): Promise<void>
  speak(text: string, options: { rate: number; priority: 'ambient' | 'answer' | 'urgent'; interrupt: boolean; speakerFallback: boolean }): Promise<string>
  stopSpeaking(): Promise<void>
  addListener?(listener: (event: { type: string; text?: string; utteranceId?: string; message?: string; route?: VoiceCapabilities['route'] }) => void): { remove(): void }
}
