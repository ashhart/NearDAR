import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { AccessibilityInfo, Platform } from 'react-native'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { selectionAsync } from 'expo-haptics'
import * as Engine from '../../../modules/tensorfold-engine/src'
import * as Perception from '../../../modules/tensorfold-perception/src'
import * as Voice from '../../../modules/tensorfold-voice/src'
import * as Vision from '../../../modules/tensorfold-vision/src'
import * as Haptics from '../../../modules/tensorfold-haptics/src'
import { useAppSettings } from '../SettingsContext'
import { WarningGate, warningIsCurrent } from './alerts'
import { headphonesDisconnected, microphoneRetryNotice, voiceErrorCode } from './voiceFeedback'
import { parseIntent } from './intents'
import { answerAhead, answerMeasuredAhead, answerQuestion, answerText, buildGenerationRequest, cameraRecoveryHint, requestedObject, requestedSide, seatAlignmentTarget, sensorLimit, validatedGeneratedAnswer } from './scene'
import { answerErrand, errandHasLabel, findErrand, shoppingCommand, type Errand, type ShoppingCommand } from './errands'
import { mergeVisionEvidence, visionPrompt } from './vision'
import { describeCurrentLocation } from './location'
import { normalizeCompanionName } from '../settings'
import { announce } from '../accessibility'
import { useVisionModel } from './useVisionModel'
import { useConversationModel } from './useConversationModel'
import type { GuidanceController, GuidanceReply, SceneSnapshot, SceneWarning, SessionState, VoiceCapabilities } from './types'

const Context = createContext<GuidanceController | null>(null)
const silenceCodes = new Set(['ERR_RECOGNITION_NO_MATCH', 'ERR_RECOGNITION_SPEECH_TIMEOUT', 'E_RECOGNITION_1110'])

async function waitForPostPermissionForeground(): Promise<boolean> {
  if (await Perception.isForeground().catch(() => false)) return true
  // Hermes in this React Native runtime does not provide Promise.withResolvers.
  return new Promise<boolean>((resolve) => {
    setTimeout(() => {
      void Perception.isForeground().then(resolve, () => resolve(false))
    }, 1000)
  })
}

export function GuidanceProvider({ children }: { children: ReactNode }) {
  const { settings, update } = useAppSettings()
  const [state, setState] = useState<SessionState>('idle')
  const [startPending, setStartPending] = useState(false)
  const [cameraPermissionBlocked, setCameraPermissionBlocked] = useState(false)
  const [statusMessage, setStatusMessage] = useState('Start guidance when your camera is unobstructed.')
  const [listening, setListening] = useState(false)
  const [handsFree, setHandsFree] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [lastReply, setLastReply] = useState<GuidanceReply>()
  const [alignment, setAlignment] = useState<GuidanceController['alignment']>()
  const [questionPhase, setQuestionPhase] = useState<GuidanceController['questionPhase']>(null)
  const [voiceNotice, setVoiceNotice] = useState<string>()
  const [voiceModelMissing, setVoiceModelMissing] = useState(false)
  const [speechDownloadPending, setSpeechDownloadPending] = useState(false)
  const [warning, setWarning] = useState<SceneWarning>()
  const [snapshot, setSnapshot] = useState<SceneSnapshot>()
  const [cameraHint, setCameraHint] = useState<string>()
  const [cameraPreviewAvailable, setCameraPreviewAvailable] = useState(false)
  const conversation = useConversationModel(setStatusMessage)
  const { capabilities: engine, status: engineStatus } = conversation
  const [voice, setVoice] = useState<VoiceCapabilities>()
  const visual = useVisionModel()
  const settingsRef = useRef(settings)
  const stateRef = useRef<SessionState>('idle')
  const errandRef = useRef<Errand | undefined>(undefined)
  const [shoppingList, setShoppingList] = useState<string[]>([])
  const replyRef = useRef<GuidanceReply | undefined>(undefined)
  const transcriptAction = useRef<(text: string) => void>(() => {})
  const gate = useRef(new WarningGate())
  const requestCounter = useRef(0)
  const activeRequest = useRef<string | undefined>(undefined)
  const conversationWork = useRef<Promise<string | undefined> | undefined>(undefined)
  const activeVisionRequest = useRef<string | undefined>(undefined)
  const activeAlignment = useRef<symbol | undefined>(undefined)
  const previousRoute = useRef<VoiceCapabilities['route']>('unknown')
  const voiceRecognition = useRef<boolean | undefined>(undefined)
  const depthExpected = useRef(false)
  const sensorDegraded = useRef(false)
  const mounted = useRef(true)
  const listeningRef = useRef(false)
  const handsFreeRef = useRef(false)
  const speakingRef = useRef(false)
  const speechId = useRef<string | undefined>(undefined)
  const speechCounter = useRef(0)
  const processingRequest = useRef<string | undefined>(undefined)
  const pausing = useRef(false)
  const starting = useRef(false)
  const cameraEpoch = useRef(0)
  const voiceTransition = useRef(false)
  const voiceRetryBlocked = useRef(false)
  const voicePermissionPending = useRef(false)
  const locationPermissionPending = useRef(false)
  const locationRequest = useRef<AbortController | null>(null)
  const textEntry = useRef(false)
  const resumeListeningRef = useRef(resumeListening)
  const statusSpeechRef = useRef(speak)
  const latestView = useRef(snapshot)
  const readinessAnnounced = useRef(false)
  const cameraActive = state === 'active' || state === 'degraded'
  const cameraReady = cameraActive && !sensorLimit(snapshot)
  settingsRef.current = settings
  stateRef.current = state
  listeningRef.current = listening
  speakingRef.current = speaking
  transcriptAction.current = (text) => { void processQuestion(text) }
  resumeListeningRef.current = resumeListening
  statusSpeechRef.current = speak
  latestView.current = snapshot

  useEffect(() => {
    if (!cameraActive) {
      readinessAnnounced.current = false
      setCameraHint(undefined)
      return
    }
    if (cameraReady) {
      setCameraHint(undefined)
      if (!readinessAnnounced.current) {
        readinessAnnounced.current = true
        if (settingsRef.current.urgentHaptics) void selectionAsync().catch(() => {})
        if (!processingRequest.current) void statusSpeechRef.current('Camera ready. You can ask a question.')
      }
      return
    }
    const timer = setTimeout(() => {
      readinessAnnounced.current = false
      const hint = cameraRecoveryHint(latestView.current)
      setCameraHint(hint)
      if (!processingRequest.current) void statusSpeechRef.current(hint)
    }, 4_000)
    return () => clearTimeout(timer)
  }, [cameraActive, cameraReady])

  async function resumeListening() {
    if (handsFreeRef.current) await beginListening()
  }

  async function beginListening() {
    if (!mounted.current || voiceRecognition.current === false || textEntry.current || pausing.current || voiceTransition.current || voiceRetryBlocked.current || voicePermissionPending.current || processingRequest.current || speakingRef.current || listeningRef.current) return
    if (stateRef.current !== 'active' && stateRef.current !== 'degraded') return
    const epoch = cameraEpoch.current
    voicePermissionPending.current = true
    try {
      await Voice.startListening({ silenceTimeoutMs: 2_400 })
      if (textEntry.current || voiceRetryBlocked.current || epoch !== cameraEpoch.current) {
        await Voice.stopListening()
      } else {
        voiceRetryBlocked.current = false
        setVoiceNotice(undefined)
        setVoiceModelMissing(false)
        listeningRef.current = true
        if (mounted.current) setListening(true)
      }
    } catch (error) {
      if (mounted.current && epoch === cameraEpoch.current && !textEntry.current && !voiceRetryBlocked.current) {
        failVoiceInput(voiceErrorCode(error), error instanceof Error ? error.message : 'On-device voice input couldn’t start.')
      }
    }
    const foreground = await waitForPostPermissionForeground()
    voicePermissionPending.current = false
    if (!foreground && epoch === cameraEpoch.current) await pause(true)
  }

  function failVoiceInput(code: string | undefined, message: string) {
    if (voiceRetryBlocked.current) return
    voiceRetryBlocked.current = true
    listeningRef.current = false
    setListening(false)
    setSessionMode(false)
    const retry = microphoneRetryNotice(code)
    setVoiceNotice(retry ?? message)
    if (retry && Platform.OS === 'ios') announce(retry)
  }

  function setSessionMode(enabled: boolean) {
    handsFreeRef.current = enabled
    setHandsFree(enabled)
  }

  function updateState(next: SessionState, message: string) {
    stateRef.current = next
    setState(next)
    setStatusMessage(message)
  }

  async function speak(text: string, urgent = false) {
    const epoch = cameraEpoch.current
    const utteranceId = `neardar-speech-${++speechCounter.current}`
    speechId.current = utteranceId
    speakingRef.current = true
    setSpeaking(true)
    await Voice.stopListening().catch(() => {})
    if (epoch !== cameraEpoch.current || speechId.current !== utteranceId) return
    listeningRef.current = false
    setListening(false)
    if (Platform.OS === 'ios' && !urgent && !handsFreeRef.current) {
      const voiceOver = await AccessibilityInfo.isScreenReaderEnabled().catch(() => false)
      if (epoch !== cameraEpoch.current || speechId.current !== utteranceId) return
      if (voiceOver && !handsFreeRef.current) {
        await Voice.stopSpeaking().catch(() => {})
        if (epoch !== cameraEpoch.current || speechId.current !== utteranceId) return
        speechId.current = undefined
        speakingRef.current = false
        setSpeaking(false)
        announce(text)
        return
      }
    }
    try {
      await Voice.speak(text, {
        utteranceId,
        voiceIdentifier: settingsRef.current.voiceIdentifier,
        rate: settingsRef.current.speechRate,
        priority: urgent ? 'urgent' : 'answer',
        interrupt: true,
        speakerFallback: settingsRef.current.speakerFallback,
      })
    } catch (error) {
      if (speechId.current !== utteranceId) return
      speechId.current = undefined
      speakingRef.current = false
      setSpeaking(false)
      const code = voiceErrorCode(error)
      const routeBlocked = code === 'E_AUDIO_ROUTE'
      if (Platform.OS === 'ios' && !routeBlocked) announce(text, !urgent)
      if (Platform.OS === 'ios' && code === 'E_AUDIO_SESSION') {
        voiceRetryBlocked.current = true
        setSessionMode(false)
        const message = 'NearDAR couldn’t play its voice. Your answer stays in Last answer. Choose Ask by voice to try again, or type your question.'
        setVoiceNotice(message)
        announce(message)
      } else {
        setVoiceNotice(error instanceof Error ? error.message : 'Speech is unavailable on this device.')
        if (routeBlocked) {
          voiceRetryBlocked.current = true
          setSessionMode(false)
        } else await resumeListening()
      }
    }
  }

  async function pause(silent = false) {
    if (pausing.current) return
    pausing.current = true
    activeAlignment.current = undefined
    setAlignment(undefined)
    if (replyRef.current?.seatTarget) {
      replyRef.current = { ...replyRef.current, seatTarget: undefined }
      setLastReply(replyRef.current)
    }
    cameraEpoch.current += 1
    errandRef.current = undefined
    speechId.current = undefined
    setSessionMode(false)
    updateState('stopping', 'Turning off the camera and microphone.')
    textEntry.current = false
    processingRequest.current = undefined
    locationRequest.current?.abort()
    setQuestionPhase(null)
    const requestId = activeRequest.current
    activeRequest.current = undefined
    const visionRequestId = activeVisionRequest.current
    activeVisionRequest.current = undefined
    const stopping = [Perception.stopSession(), Voice.stopListening(), Voice.stopSpeaking(), Haptics.stop()]
    if (requestId) stopping.push(Engine.cancel(requestId))
    if (visionRequestId) stopping.push(Vision.cancel(visionRequestId))
    await Promise.allSettled(stopping)
    await deactivateKeepAwake('guidance').catch(() => {})
    gate.current.reset()
    setSnapshot(undefined)
    setWarning(undefined)
    listeningRef.current = false
    speakingRef.current = false
    mounted.current && setListening(false)
    mounted.current && setSpeaking(false)
    updateState('paused', 'Camera and microphone off.')
    pausing.current = false
    if (!silent) await speak('Camera and microphone off.')
  }

  async function handleWarning(warning: SceneWarning) {
    const running = stateRef.current === 'active' || stateRef.current === 'degraded'
    if (!running || pausing.current || !warningIsCurrent(warning)) return
    setWarning(warning)
    if (!gate.current.accept(warning)) return
    if (activeAlignment.current && warning.severity === 'urgent') {
      void cancelAlignment('Alignment stopped. Check the nearby obstacle.')
    }
    setStatusMessage(warning.message)
    if (settingsRef.current.urgentHaptics && (warning.severity !== 'info' || warning.kind === 'sensor')) {
      void Haptics.play({ direction: warning.kind === 'sensor' ? 'unknown' : warning.direction || 'ahead', severity: warning.severity, distanceMeters: warning.distanceMeters }).catch(() => {})
    }
    await speak(warning.message, warning.severity === 'urgent')
  }

  async function start(handsFree = settingsRef.current.continuousListening) {
    if (starting.current || pausing.current || stateRef.current === 'active' || stateRef.current === 'degraded') return
    starting.current = true
    setStartPending(true)
    const epoch = ++cameraEpoch.current
    setCameraPermissionBlocked(false)
    setSessionMode(handsFree && voiceRecognition.current !== false)
    updateState('starting', 'Starting the camera.')
    gate.current.reset()
    sensorDegraded.current = false
    voiceRetryBlocked.current = false
    setVoiceNotice(undefined)
    setWarning(undefined)
    setSnapshot(undefined)
    try {
      const capabilities = await Perception.getCapabilities()
      if (epoch !== cameraEpoch.current) return
      depthExpected.current = capabilities.depth
      if (!capabilities.available) {
        setCameraPermissionBlocked(capabilities.cameraPermission === 'denied' || capabilities.cameraPermission === 'restricted')
        throw new Error(capabilities.reason || 'Camera perception is unavailable on this device.')
      }
      await Perception.startSession(settingsRef.current)
      if (epoch !== cameraEpoch.current) {
        await Perception.stopSession()
        return
      }
      // Permission promises can resolve before Android's resume event reaches React Native.
      if (!(await waitForPostPermissionForeground())) {
        if (epoch === cameraEpoch.current) await pause(true)
        return
      }
      if (epoch !== cameraEpoch.current) return
      await activateKeepAwakeAsync('guidance').catch(() => {})
      const startedCapabilities = await Perception.getCapabilities().catch(() => capabilities)
      if (epoch !== cameraEpoch.current) {
        await deactivateKeepAwake('guidance').catch(() => {})
        return
      }
      depthExpected.current = startedCapabilities.depth
      setCameraPreviewAvailable(startedCapabilities.cameraPreview === true)
      updateState(depthExpected.current ? 'active' : 'degraded', depthExpected.current ? 'Point the camera at what you want to inspect.' : 'Camera is on. Depth measurements are unavailable.')
      void prepareVision(false)
      await resumeListening()
    } catch (error) {
      await Promise.allSettled([Perception.stopSession(), deactivateKeepAwake('guidance')])
      if (epoch !== cameraEpoch.current) return
      setSessionMode(false)
      if (error && typeof error === 'object' && 'code' in error && error.code === 'E_CAMERA_PERMISSION') setCameraPermissionBlocked(true)
      const message = error instanceof Error ? error.message : 'Guidance could not start.'
      updateState('error', message)
      await speak(`Guidance could not start. ${message}`)
    } finally {
      starting.current = false
      setStartPending(false)
    }
  }

  async function handleShopping(command: ShoppingCommand) {
    if (command.kind === 'next') {
      if (shoppingList[0]) await processQuestion(`Find ${shoppingList[0]}`)
      else await deliverReply({ text: 'Your shopping list is empty.' })
      return
    }
    if (command.kind === 'check-off') {
      const errand = errandRef.current
      if (errand?.kind !== 'item' || !shoppingList.includes(errand.name)) {
        await deliverReply({ text: 'Choose an item from your shopping list first.' })
        return
      }
      const remaining = shoppingList.filter((item) => item !== errand.name)
      setShoppingList(remaining)
      await deliverReply({ text: `Crossed off ${errand.name}. ${remaining[0] ? `Next is ${remaining[0]}.` : 'Your list is complete.'}` })
      return
    }
    const items = command.kind === 'list' ? command.items : command.kind === 'clear' ? [] : shoppingList
    if (command.kind !== 'read') setShoppingList(items)
    await deliverReply({ text: items.length ? `On your list: ${items.join(', ')}. Say “next item” when you’re ready.` : 'Your shopping list is empty.' })
  }

  async function processQuestion(question: string, retry?: Errand) {
    const intent = parseIntent(question)
    if (intent.kind === 'align-seat') {
      await alignToSeat()
      return
    }
    if (intent.kind === 'stop-alignment') {
      await cancelAlignment()
      await speak('Alignment stopped.')
      return
    }
    if (activeAlignment.current || alignment) void cancelAlignment()
    const shopping = retry ? undefined : shoppingCommand(question)
    if (shopping) {
      if (!processingRequest.current && !pausing.current) await handleShopping(shopping)
      return
    }
    if (intent.kind === 'stop-session') {
      await pause()
      return
    }
    if (intent.kind === 'stop-speech') {
      await stopSpeech()
      return
    }
    if (intent.kind === 'stop-listening') {
      stopListeningInput()
      await speak('Microphone off.')
      return
    }
    if (intent.kind === 'voice-help') {
      await speak('Try find a seat, find the checkout, or help me find baked beans. Say check the label to verify a product, check again for a fresh view, or stop camera to finish.')
      return
    }
    if (intent.kind === 'repeat') {
      await repeat()
      return
    }
    if (intent.kind === 'check-again') {
      await checkAgain()
      return
    }
    if (intent.kind === 'location') {
      await sayLocation(question)
      return
    }
    if (intent.kind === 'remember-name' || intent.kind === 'forget-name') {
      const name = intent.kind === 'remember-name' ? normalizeCompanionName(intent.name) : ''
      await update({ companionName: name })
      await deliverReply({ text: name ? `I’ll call you ${name}.` : 'I’ve cleared your saved name.' })
      return
    }
    const cameraWasRunning = stateRef.current === 'active' || stateRef.current === 'degraded'
    if (!cameraWasRunning) await start()
    if (pausing.current || processingRequest.current || (stateRef.current !== 'active' && stateRef.current !== 'degraded')) return
    const errand = retry ?? findErrand(question, intent, errandRef.current)
    if (errand) errandRef.current = errand
    if (cameraWasRunning && !errand && intent.kind === 'ahead') {
      const measured = answerMeasuredAhead(snapshot)
      if (measured) {
        await deliverReply({ question, source: 'view', text: measured })
        return
      }
    }
    const canUseVisual = intent.kind !== 'read' && errand?.kind !== 'checkout' && !(errand?.kind === 'item' && errand.verify)
    requestCounter.current += 1
    const requestId = `scene-${Date.now()}-${requestCounter.current}`
    processingRequest.current = requestId
    setQuestionPhase('capturing')
    const reply = { question, source: 'view' as const, errand }
    let detail: string | undefined
    try {
      await Voice.stopListening().catch(() => {})
      setListening(false)
      listeningRef.current = false
      if (processingRequest.current !== requestId) return
      if (canUseVisual && ['installed', 'loading'].includes(visual.statusRef.current.state)) {
        setQuestionPhase('loading-model')
        await prepareVision(false)
        if (processingRequest.current !== requestId) return
      }
      setQuestionPhase('capturing')
      const useVisual = canUseVisual && visual.statusRef.current.state === 'ready'
      if (errand?.kind === 'seat' && !useVisual && visual.capabilities?.available) {
        detail = 'Get offline descriptions to check whether a visible seat looks empty.'
      }
      const captured = await Perception.captureScene({
        includeImage: useVisual,
        maxImageLongEdge: 512,
        recognizeText: intent.kind === 'read' || intent.kind === 'question' || errand?.kind === 'checkout',
      })
      let nextSnapshot: SceneSnapshot = captured
      const captureWasFresh = captured.trackingReady && Date.now() - captured.observedAt <= 3_000
      if (useVisual && !errandHasLabel(errand, captured) && processingRequest.current === requestId && captureWasFresh && (captured.imageBase64 || captured.temporaryImagePath)) {
        setQuestionPhase('looking')
        activeVisionRequest.current = `${requestId}-vision`
        try {
          const raw = await Vision.describeScene({
            requestId: activeVisionRequest.current,
            prompt: visionPrompt(errand?.kind === 'item' ? `Find ${errand.name}` : question, errand?.kind === 'seat'),
            imageBase64: captured.imageBase64,
            temporaryImagePath: captured.temporaryImagePath,
            maxTokens: 96,
          })
          nextSnapshot = mergeVisionEvidence(raw, nextSnapshot)
        } catch {
          detail = 'Offline descriptions couldn’t analyse this image. This answer uses the available camera information.'
        } finally {
          if (activeVisionRequest.current === `${requestId}-vision`) activeVisionRequest.current = undefined
        }
      }
      if (captured.temporaryImagePath) {
        try {
          await Perception.releaseCapture(captured.temporaryImagePath)
        } catch (error) {
          detail = error instanceof Error ? error.message : 'The temporary scene image could not be released.'
        }
      }
      if (processingRequest.current !== requestId) return
      const storedSnapshot = { ...nextSnapshot, imageBase64: undefined, temporaryImagePath: undefined }
      let generatedAnswer: string | undefined
      if (!errand && captureWasFresh && intent.kind === 'question' && !requestedObject(intent.question).length && !requestedSide(intent.question)) {
        generatedAnswer = await runConversation(intent.question, storedSnapshot, requestId)
      }
      if (processingRequest.current !== requestId) return
      const frozenResponse = captureWasFresh && Date.now() - captured.observedAt > 3_000
      const fallback = errand ? answerErrand(errand, nextSnapshot, frozenResponse) : intent.kind === 'read' ? answerText(nextSnapshot, frozenResponse) : intent.kind === 'question' ? answerQuestion(intent.question, nextSnapshot, frozenResponse) : answerAhead(nextSnapshot, frozenResponse)
      const responseLimit = sensorLimit(nextSnapshot, frozenResponse)
      const selected = responseLimit ?? generatedAnswer ?? fallback
      const answer = frozenResponse && !responseLimit ? `From the captured view. ${selected}` : selected
      if (processingRequest.current === requestId) processingRequest.current = undefined
      setQuestionPhase(null)
      const seatTarget = Platform.OS === 'ios' && errand?.kind === 'seat' && !responseLimit ? seatAlignmentTarget(storedSnapshot, captured) : undefined
      const text = seatTarget && handsFreeRef.current ? `${answer} Say “align to the seat” for a tap.` : answer
      await deliverReply({ ...reply, text, detail, seatTarget })
    } catch (error) {
      if (activeRequest.current === requestId) activeRequest.current = undefined
      if (activeVisionRequest.current === `${requestId}-vision`) activeVisionRequest.current = undefined
      if (processingRequest.current !== requestId) return
      processingRequest.current = undefined
      setQuestionPhase(null)
      const message = error instanceof Error ? error.message : 'Scene capture failed.'
      const answer = 'I could not inspect this view. Keep the camera uncovered and try again.'
      await deliverReply({ ...reply, text: answer, detail: message })
    }
  }

  async function prepareVision(download = true): Promise<boolean> {
    if (conversationWork.current) await conversationWork.current
    const modelState = conversation.statusRef.current.state
    if (modelState === 'unloading' || (modelState === 'ready' && !await conversation.unloadModel())) return false
    return visual.prepare(download)
  }

  function runConversation(question: string, captured: SceneSnapshot, requestId: string): Promise<string | undefined> | undefined {
    const status = conversation.statusRef.current
    const installed = status.state === 'installed' || status.state === 'ready' || (status.state === 'error' && status.installationId)
    const factsAvailable = captured.objects.length || captured.freeSeats.length || captured.recognizedText.length
    if (!engine?.available || !installed || !factsAvailable || conversationWork.current) return

    setQuestionPhase('answering')
    conversationWork.current = Promise.resolve().then(async () => {
      try {
        if (!await visual.unload(false) || processingRequest.current !== requestId) return
        if (!await conversation.loadModel() || processingRequest.current !== requestId) return
        activeRequest.current = requestId
        const raw = await Engine.generate(buildGenerationRequest(question, captured, requestId))
        return validatedGeneratedAnswer(raw, captured) || undefined
      } catch {
        if (processingRequest.current === requestId) setStatusMessage('TensorFold couldn’t answer. Showing the available camera information.')
      } finally {
        if (activeRequest.current === requestId) activeRequest.current = undefined
        await conversation.unloadModel()
        conversationWork.current = undefined
      }
    })
    return conversationWork.current
  }

  async function cancelAlignment(message?: string) {
    const running = !!activeAlignment.current
    activeAlignment.current = undefined
    setAlignment(message ? { active: false, message } : undefined)
    if (running) await Perception.cancelSeatAlignment().catch(() => {})
  }

  async function alignToSeat() {
    if (activeAlignment.current || processingRequest.current || pausing.current) return
    const target = replyRef.current?.seatTarget
    if (stateRef.current !== 'active' || !target || Date.now() - target.observedAt > 45_000) {
      await speak('I need a fresh LiDAR reading of the seat. Try finding a seat again on a supported iPhone.')
      return
    }
    const request = Symbol('seat alignment')
    activeAlignment.current = request
    const message = 'Stay where you are and turn your phone slowly. You’ll feel a tap when it points toward the seat.'
    setAlignment({ active: true, message })
    await speak(message)
    if (activeAlignment.current !== request) return
    const result = await Perception.alignToSeat(target.id, target.observedAt).catch(() => 'unavailable' as const)
    if (activeAlignment.current !== request) return
    activeAlignment.current = undefined
    const feedback = {
      aligned: 'Your phone is pointing toward the seat. Check your surroundings before moving.',
      moved: 'Alignment stopped because the phone moved. Find the seat again to refresh its position.',
      'tracking-lost': 'Camera tracking was lost. Find the seat again to refresh its position.',
      'timed-out': 'I couldn’t confirm the direction. Find the seat again to refresh its position.',
      unavailable: 'The seat position is unavailable. Find the seat again for a fresh reading.',
      cancelled: 'Alignment stopped.',
    }[result]
    if (result === 'aligned') void selectionAsync().catch(() => {})
    setAlignment({ active: false, message: feedback })
    if (result !== 'cancelled') await speak(feedback)
  }
  async function deliverReply(reply: GuidanceReply) {
    replyRef.current = reply
    setLastReply(reply)
    await speak(reply.text)
  }
  async function sayLocation(question: string) {
    if (processingRequest.current || locationRequest.current || starting.current || pausing.current) return
    const request = new AbortController()
    locationRequest.current = request
    processingRequest.current = 'location'
    setQuestionPhase('locating')
    await Voice.stopListening().catch(() => {})
    try {
      const answer = await describeCurrentLocation(request.signal, (pending) => { locationPermissionPending.current = pending })
      if (answer && !request.signal.aborted) await deliverReply({ text: answer, source: 'location', question })
    } catch {
      if (!request.signal.aborted) await deliverReply({ text: 'Your phone couldn’t look up your location right now.', question, source: 'location' })
    } finally {
      locationRequest.current = null
      if (processingRequest.current === 'location') {
        processingRequest.current = undefined
        setQuestionPhase(null)
        void resumeListening()
      }
    }
  }

  async function ask(question?: string) {
    if (question) {
      await processQuestion(question)
      return
    }
    if (stateRef.current !== 'active' && stateRef.current !== 'degraded') await start(false)
    if (textEntry.current || pausing.current || voiceTransition.current || voicePermissionPending.current || processingRequest.current || (stateRef.current !== 'active' && stateRef.current !== 'degraded')) return
    const epoch = cameraEpoch.current
    voiceTransition.current = true
    speechId.current = undefined
    await Promise.allSettled([Voice.stopSpeaking(), Voice.stopListening()])
    voiceTransition.current = false
    if (epoch !== cameraEpoch.current) return
    speakingRef.current = false
    listeningRef.current = false
    setSpeaking(false)
    setListening(false)
    voiceRetryBlocked.current = false
    if (settingsRef.current.continuousListening) setSessionMode(true)
    await beginListening()
  }

  function enableHandsFree() {
    if (stateRef.current !== 'active' && stateRef.current !== 'degraded') return
    if (voiceRecognition.current === false) return
    voiceRetryBlocked.current = false
    setVoiceNotice(undefined)
    setSessionMode(true)
    void resumeListening()
  }

  async function downloadOfflineSpeech() {
    if (speechDownloadPending) return
    setSpeechDownloadPending(true)
    setVoiceNotice('Requesting offline speech from Android.')
    try {
      const status = await Voice.downloadOfflineRecognition()
      if (status === 'ready') {
        setVoiceModelMissing(false)
        setVoiceNotice('Offline speech is ready.')
      } else {
        setVoiceNotice('Download requested. Try voice input again in a moment.')
      }
    } catch (error) {
      setVoiceNotice(error instanceof Error ? error.message : 'Offline speech download failed. Check your connection and try again.')
    } finally {
      setSpeechDownloadPending(false)
    }
  }

  function setTextEntry(active: boolean) {
    textEntry.current = active
    if (active) {
      listeningRef.current = false
      setListening(false)
      void Voice.stopListening().catch(() => {})
    } else {
      void resumeListening()
    }
  }

  function stopListeningInput() {
    setSessionMode(false)
    voiceRetryBlocked.current = true
    listeningRef.current = false
    setListening(false)
    void Voice.stopListening().catch(() => {})
  }

  async function repeat() {
    const reply = replyRef.current
    if (!reply) await speak('There is no answer to repeat yet.')
    else if (reply.source === 'view') await speak(`From the previous view. ${reply.text.replace(/^From the captured view\. /, '')}`)
    else await speak(reply.source === 'location' ? `From your last location check. ${reply.text}` : reply.text)
  }

  async function checkAgain() {
    const reply = replyRef.current
    if (!reply?.question) await speak('Ask a question first, then you can say check again.')
    else if (reply.source === 'view' && stateRef.current !== 'active' && stateRef.current !== 'degraded') await speak('Start the camera to check the view again.')
    else await processQuestion(reply.question, reply.errand)
  }

  async function checkLabel() {
    const errand = replyRef.current?.errand
    if (errand?.kind === 'item') await processQuestion('Check the label', { ...errand, verify: true })
  }

  async function stopSpeech() {
    speechId.current = undefined
    voiceTransition.current = true
    const requestId = activeRequest.current
    const visionRequestId = activeVisionRequest.current
    activeRequest.current = undefined
    activeVisionRequest.current = undefined
    processingRequest.current = undefined
    locationRequest.current?.abort()
    setQuestionPhase(null)
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

  useEffect(() => {
    mounted.current = true
    void Voice.getCapabilities().then((value) => {
      if (!mounted.current) return
      setVoice(value)
      previousRoute.current = value.route
      voiceRecognition.current = value.onDeviceRecognition
    }).catch(() => {})
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    const perceptionEvents = Perception.addPerceptionListener((event: Perception.PerceptionEvent) => {
      if (event.snapshot && !pausing.current && (stateRef.current === 'starting' || stateRef.current === 'active' || stateRef.current === 'degraded')) {
        if (event.snapshot.depthState === 'ready') depthExpected.current = true
        const healthy = event.snapshot.trackingReady && (!depthExpected.current || event.snapshot.depthState === 'ready')
        if (!healthy && stateRef.current === 'active') {
          sensorDegraded.current = true
          updateState('degraded', event.snapshot.notes[0] || 'Camera tracking or depth is not ready. Move the camera slowly.')
        } else if (healthy && sensorDegraded.current) {
          sensorDegraded.current = false
          updateState('active', 'Camera tracking and required depth are ready.')
        }
        setSnapshot(event.snapshot)
      }
      if (event.warning) void handleWarning(event.warning)
      if (event.type === 'lifecycle' && event.foreground === false && !voicePermissionPending.current && !locationPermissionPending.current && (locationRequest.current || stateRef.current === 'active' || stateRef.current === 'degraded')) void pause(true)
      if (event.message) setStatusMessage(event.message)
    })
    const voiceEvents = Voice.addVoiceListener((event: Voice.VoiceEvent) => {
      if (event.type === 'final' && event.text && !textEntry.current && !pausing.current && !processingRequest.current && (stateRef.current === 'active' || stateRef.current === 'degraded')) transcriptAction.current(event.text)
      if (event.type === 'listeningStopped') {
        listeningRef.current = false
        setListening(false)
        void resumeListeningRef.current()
      }
      if (event.type === 'speechFinished' || event.type === 'speechStopped') {
        if (event.utteranceId && event.utteranceId !== speechId.current) return
        speechId.current = undefined
        speakingRef.current = false
        setSpeaking(false)
        void resumeListeningRef.current()
      }
      if (event.type === 'routeChanged' && event.route) {
        setVoice((current) => current ? { ...current, route: event.route! } : current)
        if (headphonesDisconnected(Platform.OS, previousRoute.current, event.route, event.audioRoute)) {
          if (settingsRef.current.speakerFallback && event.route === 'speaker') void speak('Headphones disconnected. Using the phone speaker.')
          else void pause(true).then(() => settingsRef.current.speakerFallback ? speak('Headphones disconnected. Guidance paused.') : undefined)
        }
        previousRoute.current = event.route
      }
      if (event.type === 'error' && event.message && !silenceCodes.has(event.code ?? '') && !pausing.current) {
        if (event.operation === 'recognition' || event.operation === 'startListening') {
          if (event.code === 'ERR_RECOGNITION_MODEL_MISSING') setVoiceModelMissing(true)
          failVoiceInput(event.code, event.message)
          return
        }
        if (event.operation === 'speak') return
        if (event.code === 'ERR_RECOGNITION_MODEL_MISSING') setVoiceModelMissing(true)
        setVoiceNotice(event.message)
      }
    })
    return () => {
      pausing.current = true
      activeAlignment.current = undefined
      processingRequest.current = undefined
      locationRequest.current?.abort()
      perceptionEvents.remove()
      voiceEvents.remove()
      void Promise.allSettled([Perception.stopSession(), Voice.stopListening(), Voice.stopSpeaking(), Haptics.stop()])
    }
    // Subscribe once; handlers read changing settings and session state through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const controller: GuidanceController = {
    state, startPending, cameraPermissionBlocked, statusMessage, listening, handsFree, speaking, questionPhase, voiceNotice,
    voiceModelMissing, speechDownloadPending, warning, lastReply, alignment, snapshot, shoppingList, cameraReady, cameraHint, cameraPreviewAvailable,
    engine, engineStatus, vision: visual.capabilities, visionStatus: visual.status, voice,
    installModel: conversation.installModel, cancelModelInstall: conversation.cancelModelInstall,
    prepareVisionModel: prepareVision, cancelVisionInstall: visual.cancelInstall, unloadVisionModel: async () => { await visual.unload() },
    start, stop: pause, ask, enableHandsFree, downloadOfflineSpeech, stopListeningInput, setTextEntry, repeat, checkAgain, checkLabel, alignToSeat, cancelAlignment,
    stopSpeech,
  }

  return <Context.Provider value={controller}>{children}</Context.Provider>
}

export function useGuidance(): GuidanceController {
  const value = useContext(Context)
  if (!value) throw new Error('GuidanceProvider is missing')
  return value
}
