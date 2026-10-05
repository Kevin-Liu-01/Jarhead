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
  headSpeaking: "Slack asks",
  headAlarm: "Alarm · weekdays",
  working: "Working",
  tiles: ["Slack", "Spotify"] as const,
  tileState: "working",
  allow: "Allow",
  deny: "Deny",
  snooze: "Snooze 10",
  done: "Done",
  five: "5",
  thirty: "30",
  sayAwake: "Say something…",
  sayAsleep: "Asleep · press Go",
  footClock: "12:37",
  footMeter: "7.2 min · $0.36",
  /** The asleep foot line, as the app draws it: `asleep`, then the next thing armed (notch-island-alarm.png). */
  footAsleep: "asleep · next Timer 11:56 · pasta",
  clockBase: { thinking: 1, acting: 8 } as const,
};
