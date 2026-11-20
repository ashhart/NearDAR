export type GuidanceIntent =
  | { kind: 'stop-session' }
  | { kind: 'stop-speech' }
  | { kind: 'stop-listening' }
  | { kind: 'voice-help' }
  | { kind: 'repeat' }
  | { kind: 'check-again' }
  | { kind: 'seat' }
  | { kind: 'ahead' }
  | { kind: 'read' }
  | { kind: 'location' }
  | { kind: 'remember-name'; name: string }
  | { kind: 'forget-name' }
  | { kind: 'question'; question: string }


export function parseIntent(text: string): GuidanceIntent {
  const value = text.trim().toLowerCase().replace(/’/g, "'").replace(/[.!?]+$/g, '').replace(/\s+/g, ' ')
  if (/^(pause guidance|stop guidance|end guidance|stop session|stop camera|turn off the camera)$/.test(value)) return { kind: 'stop-session' }
  if (/^(stop listening|pause listening|turn off (?:the )?microphone)$/.test(value)) return { kind: 'stop-listening' }
  if (/^(voice commands|what can i (?:ask|say)|how do i use (?:this|neardar))$/.test(value)) return { kind: 'voice-help' }
  if (/^(stop|be quiet|quiet|stop talking|cancel)$/.test(value)) return { kind: 'stop-speech' }
  if (/^(repeat|say that again|repeat that)$/.test(value)) return { kind: 'repeat' }
  if (/^(check again|look again|check that again)$/.test(value)) return { kind: 'check-again' }
  if (/^(where (?:am i|are we)|what(?:'s| is) my (?:current )?location|tell me where i am)$/.test(value)) return { kind: 'location' }
  const name = /^(?:call me|remember (?:that )?my name is)\s+(.+?)[.!?]*$/i.exec(text.trim())?.[1]?.trim()
  if (name) return { kind: 'remember-name', name }
  if (/^forget my name$/.test(value)) return { kind: 'forget-name' }
  if (/\b(?:where can (?:i|we) sit|place to sit|can (?:i|we) sit)\b|\b(?:find|which|available|free|empty|unoccupied|vacant)\b.*\b(?:seats?|chairs?|bench|stool)\b|\b(?:seats?|chairs?|bench|stool)\b.*\b(?:available|free|empty|unoccupied|vacant|occupied|taken|sit)\b/.test(value)) return { kind: 'seat' }
  if (/^(read|read this|read text|read (?:this|the) (?:sign|menu|label|text)|what does (this|that) say)$/.test(value)) return { kind: 'read' }
  if (/^(what(?:'s| is)? (ahead|in front)|describe ahead|obstacles ahead|around me|what(?:'s| is)? around)$/.test(value)) return { kind: 'ahead' }
  const side = /^(?:look|check) (?:to (?:my|the) )?(left|right)$/.exec(value)?.[1]
  if (side) return { kind: 'question', question: `What is on my ${side}?` }
  return { kind: 'question', question: text.trim() }
}
