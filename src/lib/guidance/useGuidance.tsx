import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import * as Engine from '../../../modules/tensorfold-engine/src'
import * as Perception from '../../../modules/tensorfold-perception/src'
import * as Voice from '../../../modules/tensorfold-voice/src'
import * as Vision from '../../../modules/tensorfold-vision/src'
import * as Haptics from '../../../modules/tensorfold-haptics/src'
import { useAppSettings } from '../SettingsContext'
import { WarningGate } from './alerts'
import { parseIntent } from './intents'
import { answerAhead, answerQuestion, answerSeats, answerText, buildGenerationRequest, sensorLimit, validatedGeneratedAnswer } from './scene'
import { mergeVisionEvidence, visionPrompt } from './vision'
import type { EngineCapabilities, EngineStatus, GuidanceController, SceneSnapshot, SceneWarning, SessionState, VoiceCapabilities } from './types'


const Context = createContext<GuidanceController | null>(null)

async function waitForPostPermissionForeground(): Promise<boolean> {
  if (await Perception.isForeground().catch(() => false)) return true
  // Hermes in this React Native runtime does not provide Promise.withResolvers.
  return new Promise<boolean>((resolve) => {
    setTimeout(() => {
      void Perception.isForeground().then(resolve, () => resolve(false))
    }, 1000)
  })
}

function isInstallCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: string; name?: string }
  return candidate.code === 'E_INSTALL_CANCELLED' || candidate.name === 'AbortError'
}

export function GuidanceProvider({ children }: { children: ReactNode }) {
  const { settings } = useAppSettings()
  const [state, setState] = useState<SessionState>('idle')
  const [statusMessage, setStatusMessage] = useState('Start guidance when your camera is unobstructed.')
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [lastAnswer, setLastAnswer] = useState('')
  const [lastTranscript, setLastTranscript] = useState('')
  const [snapshot, setSnapshot] = useState<SceneSnapshot>()
  const [engine, setEngine] = useState<EngineCapabilities>()
  const [engineStatus, setEngineStatus] = useState<EngineStatus>({ state: 'not-installed' })
  const [voice, setVoice] = useState<VoiceCapabilities>()
  const [vision, setVision] = useState<EngineCapabilities>()
  const [visionStatus, setVisionStatus] = useState<EngineStatus>({ state: 'not-installed' })
  const snapshotRef = useRef<SceneSnapshot | undefined>(undefined)
  const settingsRef = useRef(settings)
  const stateRef = useRef<SessionState>('idle')
  const answerRef = useRef('')
  const transcriptAction = useRef<(text: string) => void>(() => {})
  const gate = useRef(new WarningGate())
  const requestCounter = useRef(0)
  const activeRequest = useRef<string | undefined>(undefined)
  const activeVisionRequest = useRef<string | undefined>(undefined)
  const previousRoute = useRef<VoiceCapabilities['route']>('unknown')
  const depthExpected = useRef(false)
  const sensorDegraded = useRef(false)
  const mounted = useRef(true)
  const listeningRef = useRef(false)
  const speakingRef = useRef(false)
  const processingRequest = useRef<string | undefined>(undefined)
  const pausing = useRef(false)
  const voiceTransition = useRef(false)
  const voiceRetryBlocked = useRef(false)
  const voicePermissionPending = useRef(false)

  settingsRef.current = settings
  snapshotRef.current = snapshot
  stateRef.current = state
  answerRef.current = lastAnswer
  listeningRef.current = listening
  speakingRef.current = speaking
  transcriptAction.current = (text) => { void processQuestion(text) }

  async function resumeListening() {
    if (!mounted.current || !settingsRef.current.continuousListening || pausing.current || voiceTransition.current || voiceRetryBlocked.current || processingRequest.current || speakingRef.current || listeningRef.current) return
    if (stateRef.current !== 'active' && stateRef.current !== 'degraded') return
    voicePermissionPending.current = true
    try {
      await Voice.startListening()
      voiceRetryBlocked.current = false
      listeningRef.current = true
      if (mounted.current) setListening(true)
    } catch (error) {
      voiceRetryBlocked.current = true
      listeningRef.current = false
      if (mounted.current) {
        setListening(false)
        setStatusMessage(error instanceof Error ? error.message : 'Continuous on-device listening is unavailable. Use the Ask a question control.')
      }
    }
    const foreground = await waitForPostPermissionForeground()
    voicePermissionPending.current = false
    if (!foreground && (stateRef.current === 'active' || stateRef.current === 'degraded')) await pause(true)
  }

  function updateState(next: SessionState, message: string) {
    if (next === 'starting') pausing.current = false
    stateRef.current = next
    setState(next)
    setStatusMessage(message)
  }

  async function speak(text: string, urgent = false) {
    speakingRef.current = true
    setSpeaking(true)
    await Voice.stopListening().catch(() => {})
    listeningRef.current = false
    setListening(false)
    try {
      await Voice.speak(text, {
        rate: settingsRef.current.speechRate,
        priority: urgent ? 'urgent' : 'answer',
        interrupt: true,
        speakerFallback: settingsRef.current.speakerFallback,
      })
    } catch (error) {
      speakingRef.current = false
      setSpeaking(false)
      setStatusMessage(error instanceof Error ? error.message : 'Speech is unavailable on this device.')
      await resumeListening()
    }
  }

  async function pause(silent = false) {
    pausing.current = true
    processingRequest.current = undefined
    const requestId = activeRequest.current
    if (requestId) await Engine.cancel(requestId).catch(() => {})
    activeRequest.current = undefined
    const visionRequestId = activeVisionRequest.current
    if (visionRequestId) await Vision.cancel(visionRequestId).catch(() => {})
    activeVisionRequest.current = undefined
    await Promise.allSettled([Perception.stopSession(), Voice.stopListening(), Voice.stopSpeaking(), Haptics.stop()])
    await deactivateKeepAwake('guidance')
    gate.current.reset()
    mounted.current && setListening(false)
    mounted.current && setSpeaking(false)
    updateState('paused', 'Guidance paused. Start again when the camera is unobstructed.')
    if (!silent) await speak('Guidance paused.')
  }

  async function handleWarning(warning: SceneWarning) {
    const running = stateRef.current === 'active' || stateRef.current === 'degraded'
    if (!running || !gate.current.accept(warning)) return
    setStatusMessage(warning.message)
    if (settingsRef.current.urgentHaptics && (warning.severity !== 'info' || warning.kind === 'sensor')) {
      void Haptics.play({ direction: warning.kind === 'sensor' ? 'unknown' : warning.direction || 'ahead', severity: warning.severity, distanceMeters: warning.distanceMeters }).catch(() => {})
    }
    await speak(warning.message, warning.severity === 'urgent')
  }

  async function start() {
    if (stateRef.current === 'starting' || stateRef.current === 'active') return
    updateState('starting', 'Starting camera, depth, and voice services.')
    gate.current.reset()
    sensorDegraded.current = false
    voiceRetryBlocked.current = false
    snapshotRef.current = undefined
    setSnapshot(undefined)
    try {
      const capabilities = await Perception.getCapabilities()
      depthExpected.current = capabilities.depth
      if (!capabilities.available) throw new Error(capabilities.reason || 'Camera perception is unavailable on this device.')
      await Perception.startSession(settingsRef.current)
      // Permission promises can resolve before Android's resume event reaches React Native.
      if (!(await waitForPostPermissionForeground())) {
        await pause(true)
        return
      }
      await activateKeepAwakeAsync('guidance')
      updateState(capabilities.depth ? 'active' : 'degraded', capabilities.depth ? 'Guidance active. Point the camera where you want to inspect.' : 'Camera guidance is active without depth. Distances and step estimates are unavailable.')
      await speak(capabilities.depth ? 'Guidance started.' : 'Guidance started without depth measurements.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Guidance could not start.'
      updateState('error', message)
      await speak(`Guidance could not start. ${message}`)
    }
  }

  async function processQuestion(question: string) {
    const intent = parseIntent(question)
    if (intent.kind === 'stop-session') {
      await pause()
      return
    }
    if (intent.kind === 'stop-speech') {
      await stopSpeech()
      return
    }
    if (intent.kind === 'repeat') {
      await repeat()
      return
    }
    if (stateRef.current !== 'active' && stateRef.current !== 'degraded') await start()
    if (stateRef.current === 'error') return
    if (processingRequest.current) return
    setLastTranscript(question)
    requestCounter.current += 1
    const requestId = `scene-${Date.now()}-${requestCounter.current}`
    processingRequest.current = requestId
    try {
      await Voice.stopListening()
      setListening(false)
      listeningRef.current = false
      void speak('Inspecting the current view.')
      const captured = await Perception.captureScene()
      let nextSnapshot: SceneSnapshot = captured
      const captureWasFresh = captured.trackingReady && Date.now() - captured.observedAt <= 3_000
      if (visionStatus.state === 'ready' && processingRequest.current === requestId && stateRef.current !== 'paused' && (captured.imageBase64 || captured.temporaryImagePath)) {
        activeVisionRequest.current = `${requestId}-vision`
        try {
          const raw = await Vision.describeScene({
            requestId: activeVisionRequest.current,
            prompt: visionPrompt(intent.kind === 'question' ? intent.question : question),
            imageBase64: captured.imageBase64,
            temporaryImagePath: captured.temporaryImagePath,
            maxTokens: 96,
          })
          nextSnapshot = mergeVisionEvidence(raw, nextSnapshot)
        } catch (error) {
          nextSnapshot = { ...nextSnapshot, notes: [...nextSnapshot.notes, error instanceof Error ? error.message : 'Visual inference is unavailable.'] }
        } finally {
          if (activeVisionRequest.current === `${requestId}-vision`) activeVisionRequest.current = undefined
        }
      }
      if (captured.temporaryImagePath) {
        try {
          await Perception.releaseCapture(captured.temporaryImagePath)
        } catch (error) {
          setStatusMessage(error instanceof Error ? error.message : 'The temporary scene image could not be released.')
        }
      }
      if (stateRef.current === 'paused' || processingRequest.current !== requestId) return
      const storedSnapshot = { ...nextSnapshot, imageBase64: undefined, temporaryImagePath: undefined }
      snapshotRef.current = storedSnapshot
      setSnapshot(storedSnapshot)
      let generatedAnswer: string | undefined
      if (engineStatus.state === 'ready' && intent.kind === 'question') {
        activeRequest.current = requestId
        try {
          const raw = await Engine.generate(buildGenerationRequest(intent.kind === 'question' ? intent.question : question, nextSnapshot, requestId))
          generatedAnswer = validatedGeneratedAnswer(raw, nextSnapshot) || undefined
        } catch (error) {
          if (processingRequest.current === requestId) setStatusMessage(error instanceof Error ? error.message : 'TensorFold inference is unavailable; using measured scene facts.')
        } finally {
          if (activeRequest.current === requestId) activeRequest.current = undefined
        }
      }
      if ((stateRef.current as SessionState) === 'paused' || processingRequest.current !== requestId) return
      const frozenResponse = captureWasFresh && Date.now() - captured.observedAt > 3_000
      const fallback = intent.kind === 'seat' ? answerSeats(nextSnapshot, frozenResponse) : intent.kind === 'read' ? answerText(nextSnapshot, frozenResponse) : intent.kind === 'question' ? answerQuestion(intent.question, nextSnapshot, frozenResponse) : answerAhead(nextSnapshot, frozenResponse)
      const responseLimit = sensorLimit(nextSnapshot, frozenResponse)
      const selected = responseLimit ?? generatedAnswer ?? fallback
      const answer = frozenResponse && !responseLimit ? `From the captured view: ${selected}` : selected
      setLastAnswer(answer)
      answerRef.current = answer
      if (processingRequest.current === requestId) processingRequest.current = undefined
      await speak(answer)
    } catch (error) {
      if (activeRequest.current === requestId) activeRequest.current = undefined
      if (activeVisionRequest.current === `${requestId}-vision`) activeVisionRequest.current = undefined
      if (stateRef.current === 'paused' || processingRequest.current !== requestId) return
      processingRequest.current = undefined
      const message = error instanceof Error ? error.message : 'Scene capture failed.'
      setStatusMessage(message)
      await speak('I could not inspect this view. Keep the camera uncovered and try again.')
    }
  }

  async function ask(question?: string) {
    if (question) {
      await processQuestion(question)
      return
    }
    if (stateRef.current !== 'active' && stateRef.current !== 'degraded') await start()
    if (stateRef.current === 'error' || processingRequest.current) return
    voiceTransition.current = true
    await Promise.allSettled([Voice.stopSpeaking(), Voice.stopListening()])
    speakingRef.current = false
    listeningRef.current = false
    setSpeaking(false)
    setListening(false)
    let failure: string | undefined
    try {
      voiceRetryBlocked.current = false
      voicePermissionPending.current = true
      await Voice.startListening()
      listeningRef.current = true
      setListening(true)
    } catch (error) {
      voiceRetryBlocked.current = true
      failure = error instanceof Error ? error.message : 'On-device speech recognition is unavailable.'
      setStatusMessage(failure)
    } finally {
      voiceTransition.current = false
    }
    const foreground = await waitForPostPermissionForeground()
    voicePermissionPending.current = false
    if (!foreground && (stateRef.current === 'active' || stateRef.current === 'degraded')) {
      await pause(true)
      return
    }
    if (failure) await speak(failure)
  }

  async function repeat() {
    const answer = answerRef.current
    await speak(answer || 'There is no answer to repeat yet.')
  }

  async function stopSpeech() {
    voiceTransition.current = true
    const requestId = activeRequest.current
    const visionRequestId = activeVisionRequest.current
    activeRequest.current = undefined
    activeVisionRequest.current = undefined
    processingRequest.current = undefined
    try {
      const cancellations = [Voice.stopSpeaking(), Voice.stopListening()]
      if (requestId) cancellations.push(Engine.cancel(requestId).catch(() => {}))
      if (visionRequestId) cancellations.push(Vision.cancel(visionRequestId).catch(() => {}))
      await Promise.allSettled(cancellations)
      speakingRef.current = false
      listeningRef.current = false
      setSpeaking(false)
      setListening(false)
    } finally {
      voiceTransition.current = false
    }
    await resumeListening()
  }

  async function installModel() {
    setEngineStatus({ state: 'downloading', progress: 0, message: 'Preparing the model download.' })
    try {
      const result = await Engine.installModel()
      setEngineStatus(result)
    } catch (error) {
      if (isInstallCancellation(error)) setEngineStatus({ state: 'not-installed', message: 'Download cancelled. No model was installed.' })
      else setEngineStatus({ state: 'error', message: error instanceof Error ? error.message : 'Model installation failed.' })
    }
  }

  async function cancelModelInstall() {
    try {
      if (await Engine.cancelInstall()) setEngineStatus({ state: 'not-installed', message: 'Download cancelled. No model was installed.' })
    } catch (error) {
      setEngineStatus({ state: 'error', message: error instanceof Error ? error.message : 'Could not cancel the model download.' })
    }
  }

  async function unloadModel() {
    setEngineStatus({ ...engineStatus, state: 'unloading', message: 'Unloading the conversation model.' })
    try {
      await Engine.unloadModel()
      setEngineStatus({ ...engineStatus, state: 'installed', message: 'Conversation model unloaded. Sensor guidance remains available.' })
    } catch (error) {
      setEngineStatus({ ...engineStatus, state: 'error', message: error instanceof Error ? error.message : 'Could not unload the conversation model.' })
    }
  }

  async function loadModel() {
    setEngineStatus({ state: 'loading', installationId: engineStatus.installationId, message: 'Loading TensorFold into memory.' })
    try {
      const result = await Engine.loadModel(engineStatus.installationId)
      setEngineStatus(result)
    } catch (error) {
      setEngineStatus({ state: 'error', installationId: engineStatus.installationId, message: error instanceof Error ? error.message : 'Model loading failed.' })
    }
  }

  async function installVisionModel() {
    setVisionStatus({ state: 'downloading', progress: 0, message: 'Preparing the visual model download.' })
    try {
      setVisionStatus(await Vision.installModel())
    } catch (error) {
      if (isInstallCancellation(error)) setVisionStatus({ state: 'not-installed', message: 'Download cancelled. No visual model was installed.' })
      else setVisionStatus({ state: 'error', message: error instanceof Error ? error.message : 'Visual model installation failed.' })
    }
  }

  async function cancelVisionInstall() {
    try {
      await Vision.cancelInstall()
      setVisionStatus({ state: 'not-installed', message: 'Download cancelled. No visual model was installed.' })
    } catch (error) {
      setVisionStatus({ state: 'error', message: error instanceof Error ? error.message : 'Could not cancel the visual model download.' })
    }
  }

  async function unloadVisionModel() {
    setVisionStatus({ ...visionStatus, state: 'unloading', message: 'Unloading the visual model.' })
    try {
      await Vision.unloadModel()
      setVisionStatus({ ...visionStatus, state: 'installed', message: 'Visual model unloaded.' })
    } catch (error) {
      setVisionStatus({ ...visionStatus, state: 'error', message: error instanceof Error ? error.message : 'Could not unload the visual model.' })
    }
  }

  async function loadVisionModel() {
    setVisionStatus({ state: 'loading', installationId: visionStatus.installationId, message: 'Loading SmolVLM2 into memory.' })
    try {
      setVisionStatus(await Vision.loadModel(visionStatus.installationId))
    } catch (error) {
      setVisionStatus({ state: 'error', installationId: visionStatus.installationId, message: error instanceof Error ? error.message : 'Visual model loading failed.' })
    }
  }

  useEffect(() => {
    mounted.current = true
    void Promise.allSettled([Engine.getCapabilities(), Engine.getStatus(), Voice.getCapabilities(), Vision.getCapabilities(), Vision.getStatus()]).then(([engineCaps, storedStatus, voiceCaps, visionCaps, storedVisionStatus]) => {
      if (!mounted.current) return
      if (engineCaps.status === 'fulfilled') setEngine(engineCaps.value)
      if (storedStatus.status === 'fulfilled') setEngineStatus(storedStatus.value)
      if (voiceCaps.status === 'fulfilled') setVoice(voiceCaps.value)
      if (voiceCaps.status === 'fulfilled') previousRoute.current = voiceCaps.value.route
      if (visionCaps.status === 'fulfilled') setVision(visionCaps.value)
      if (storedVisionStatus.status === 'fulfilled') setVisionStatus(storedVisionStatus.value)
    })
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (settings.continuousListening) {
      voiceRetryBlocked.current = false
      void resumeListening()
    }
    else {
      listeningRef.current = false
      setListening(false)
      void Voice.stopListening().catch(() => {})
    }
  }, [settings.continuousListening])

  useEffect(() => {
    const engineEvents = Engine.addEngineListener((event: Engine.EngineEvent) => {
      if (event.status) setEngineStatus(event.status)
      if (event.type === 'error' && event.message) setStatusMessage(event.message)
    })
    const visionEvents = Vision.addVisionListener((event: Vision.VisionEvent) => {
      if (event.status) setVisionStatus(event.status)
      if (event.type === 'error' && event.message) setStatusMessage(event.message)
    })
    const perceptionEvents = Perception.addPerceptionListener((event: Perception.PerceptionEvent) => {
      if (event.snapshot) {
        const healthy = event.snapshot.trackingReady && (!depthExpected.current || event.snapshot.depthState === 'ready')
        if (!healthy && stateRef.current === 'active') {
          sensorDegraded.current = true
          updateState('degraded', event.snapshot.notes[0] || 'Camera tracking or depth is not ready. Move the camera slowly.')
        } else if (healthy && sensorDegraded.current) {
          sensorDegraded.current = false
          updateState('active', 'Camera tracking and required depth are ready.')
          void speak('Camera tracking recovered.')
        }
        snapshotRef.current = event.snapshot
        setSnapshot(event.snapshot)
      }
      if (event.warning) void handleWarning(event.warning)
      if (event.type === 'lifecycle' && event.foreground === false && !voicePermissionPending.current && (stateRef.current === 'active' || stateRef.current === 'degraded')) void pause(true)
      if (event.message) setStatusMessage(event.message)
    })
    const voiceEvents = Voice.addVoiceListener((event: Voice.VoiceEvent) => {
      if (event.type === 'final' && event.text && !processingRequest.current) transcriptAction.current(event.text)
      if (event.type === 'listeningStopped') {
        listeningRef.current = false
        setListening(false)
        void resumeListening()
      }
      if (event.type === 'speechFinished' || event.type === 'speechStopped') {
        speakingRef.current = false
        setSpeaking(false)
        void resumeListening()
      }
      if (event.type === 'routeChanged' && event.route) {
        setVoice((current) => current ? { ...current, route: event.route! } : current)
        if (previousRoute.current === 'headphones' && event.route !== 'headphones') {
          if (settingsRef.current.speakerFallback && event.route === 'speaker') void speak('Headphones disconnected. Using the phone speaker.')
          else void pause(true).then(() => settingsRef.current.speakerFallback ? speak('Headphones disconnected. Guidance paused.') : undefined)
        }
        previousRoute.current = event.route
      }
      if (event.type === 'error' && event.message) setStatusMessage(event.message)
    })
    return () => {
      pausing.current = true
      processingRequest.current = undefined
      engineEvents.remove()
      perceptionEvents.remove()
      visionEvents.remove()
      voiceEvents.remove()
      void Promise.allSettled([Perception.stopSession(), Voice.stopListening(), Voice.stopSpeaking(), Haptics.stop()])
    }
    // Subscribe once; handlers read changing settings and session state through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const controller: GuidanceController = {
    state, statusMessage, listening, speaking, processing: processingRequest.current !== undefined, lastAnswer, lastTranscript, snapshot,
    engine, engineStatus, vision, visionStatus, voice,
    installModel, loadModel, cancelModelInstall, unloadModel,
    installVisionModel, loadVisionModel, cancelVisionInstall, unloadVisionModel,
    start, stop: pause, ask, repeat, stopSpeech,
  }

  return <Context.Provider value={controller}>{children}</Context.Provider>
}

export function useGuidance(): GuidanceController {
  const value = useContext(Context)
  if (!value) throw new Error('GuidanceProvider is missing')
  return value
}
