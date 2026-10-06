/**
 * The island's own rendered text (README:54, README:60, README:132-134, README:289-296, docs/DEMO.md:21; notch-island*.png),
 * byte for byte: the app's strings over the harness's fixed data, nothing here is a claim. A plain module (no "use client"),
 * so the demos (components/play/*) and the client island read the same strings.
 */
export const ISLAND = {
  word: { listening: "Listening", thinking: "Thinking", acting: "Acting", speaking: "Speaking", asleep: "Asleep", alarm: "Alarm" } as const,
  hero: {
    listening: "Tell Ben on Slack I'm late and put on Focus on Spotify",
    thinking: "Three independent apps: Notes and Spotify take Apple events, Slack needs the pointer.",
    acting: "opening the PR in Cursor",
    speaking: 'Slack asks: send "I\'m running late" to Ben?',
    alarm: "07:10 · Wake up, Kevin",
  } as const,
  alarmSub: "Monday · standup notes at 9",
  /** Asleep, the hero is the wake gate's own words, set calm (the app's island, Kevin's screenshot, 2026-10-05). */
  gate: "Listening for “jarhead”",
  /** The question in the hero; the head names who asks (`headSpeaking`), so the hero never says it twice. */
  question: "Send “I'm running late” to Ben?",
  headSpeaking: "Slack asks",
  headAlarm: "Alarm · weekdays",
  working: "Working",
  tiles: ["Slack", "Spotify"] as const,
  tileState: "working",
  allow: "Allow",
  deny: "Deny",
  snooze: "Snooze 10",
  done: "Done",
  sayAwake: "Say something…",
  sayAsleep: "Asleep · press Go",
  footClock: "12:37",
  footMeter: "7.2 min · $0.36",
  /**
   * The app's asleep row with a timer armed (notch-island-alarm.png): `asleep`, then the next thing. The island's own
   * asleep row names the 07:10 alarm the Sleep night runs to (its noun is this line's first word); Sleep cuts its timer
   * example from here.
   */
  footAsleep: "asleep · next Timer 11:56 · pasta",
  /** The asleep row's clause with no fire armed and nothing used today (NotchPanel.swift asleepClause): while the alarm rings. */
  footRing: "nothing billed",
  clockBase: { thinking: 1, acting: 8 } as const,
};
