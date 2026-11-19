export type GuidanceIntent =
  | { kind: 'stop-session' }
  | { kind: 'stop-speech' }
  | { kind: 'repeat' }
  | { kind: 'seat' }
  | { kind: 'ahead' }
  | { kind: 'read' }
  | { kind: 'question'; question: string }


export function parseIntent(text: string): GuidanceIntent {
  const value = text.trim().toLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ')
  if (/^(pause guidance|stop guidance|end guidance|stop session)$/.test(value)) return { kind: 'stop-session' }
  if (/^(stop|be quiet|quiet|stop talking|cancel)$/.test(value)) return { kind: 'stop-speech' }
  if (/^(repeat|say that again|repeat that)$/.test(value)) return { kind: 'repeat' }
  if (/(find|available|free|empty).*(seat|chair|table)|(seat|chair|table).*(find|available|free|empty)/.test(value)) return { kind: 'seat' }
  if (/^(read|read this|read the sign|what does (this|that) say|read text)$/.test(value)) return { kind: 'read' }
  if (/^(what(?:'s| is)? (ahead|in front)|describe ahead|obstacles ahead|around me|what(?:'s| is)? around)$/.test(value)) return { kind: 'ahead' }
  return { kind: 'question', question: text.trim() }
}
