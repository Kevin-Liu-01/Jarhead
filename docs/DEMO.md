# The demo

> The take that was posted (2026-09-11 build, 4 min 35 s) predates the island, the dithered
> blob and the Console's left rail; the README's pictures are current. Below is the plan for a
> ninety-second take.

One take, ninety seconds, no cuts, the Mac's own audio. Latency is the product, so the
recording has to show the gap between the last word and the first visible action. A cut
would make people assume it was edited. Record with QuickTime (File › New Screen
Recording, the built-in mic on, or a lavalier through Audio MIDI Setup) or CleanShot; keep
the Console open on the right third of the screen so the viewer sees the Now panel and the
Threads rail while the left two thirds show the apps being driven.

## The ninety-second take

| t | Kevin says | What the screen shows |
|---|---|---|
| 0:00 | (nothing) | The blob asleep in the notch, eyes `- -`. Cursor idle. |
| 0:03 | "Jarhead." | The blob drops out of the notch, the island opens: **Listening**. Meter starts. |
| 0:06 | "Search the wiki for design." | Under a second later the wiki is in front and `design` is typed into its search. No narration first. |
| 0:15 | "Tell Ben on Slack I'm running late, and put on Focus on Spotify." | "On it." Then **"Spotify alongside."** Spotify starts playing without the pointer moving. Slack comes to the front and the message is typed with Slack in front. The Threads rail shows `Spotify · working` and `Slack · working` under the main card. |
| 0:32 | (Jarhead) "May I send it? Say yes." | The Send question, spoken once. The message sits unsent in Slack. |
| 0:35 | "Yes." | Sent. "Sent." Spotify's finish line was already spoken once: "Spotify: playing Focus." Nothing repeats. |
| 0:42 | "Open my calendar and — stop." | Everything halts within a frame. "Stopped." The meter keeps running: a spoken stop is the interrupt, not the end. |
| 0:50 | "Move today's screenshots to the Trash." | Jarhead asks before anything destructive. |
| 0:55 | "No." | Nothing moves. The ledger shows the question and the no. |
| 1:02 | "Open the Console." (or click the blob) | The Console: the conversation on the left, the Now stream with every step and screenshot, the Threads rail, the meter with dollars. Scroll once. |
| 1:15 | "That's all. Goodnight." | **"night."** The meter stops within two seconds. The blob flies home and tucks into the notch. |
| 1:22 | (nothing) | Hold on the tucked notch for three seconds. End on the Dock icon. |

Say each line at normal speed and then stop talking. The pauses are the demo.

## Pre-flight (ten minutes before)

- `pnpm jarhead status`: phase asleep, brain ready, hands ready, **16/16 permissions**, `threads 1 (1 live)` (main alone), no problems. If a problem row shows, fix it or the island will show it.
- `pnpm jarhead dock`: one Jarhead tile. If two, `pnpm jarhead dock --fix` (the Dock restarts once).
- Slack open on a DM to yourself (or a test channel) so "Ben" is a real, harmless target; Spotify open and signed in with a playlist literally named **Focus**; the wiki app open on any page.
- Close everything else. Notifications off (Focus mode). Wi-Fi solid: the voice is a live socket.
- Rehearse the sleep line once so the phrasing is one the grammar knows: "go to sleep", "goodnight jarhead", "that's all", "that will be all", "power down", "shut off". Not "shut down" and not "sleep" alone — those are deliberately not cues.
- Know the recovery moves: **Pause** (the island's Go/Pause circle) closes the paid session and holds the conversation; **Go** resumes; the Console's **Stop** on a thread's row in the Threads rail ends that thread only.
- Fresh daemon: quit Jarhead fully, `open -a Jarhead`, wait for the island to show the gate. A stale daemon is the one thing that has bitten before.

## The thirty-second cut (social)

From the same take: 0:15 to 0:42 (the split, Spotify starting with the pointer still, the Send question and the yes) and 1:15 to 1:25 (the farewell and the tuck). Add one caption at the top: *"two apps at once, one question, and it goes to sleep when you say so."* Nothing else.

## The five-minute technical walkthrough

For an audience that builds things. Same take first, then:

1. **The ledger.** Console › Ledger. Every row is append-only; show a `thread.started` row and its `thread.ended`, the `sleep` row with its cause, a `grant` row from the yes. Search it.
2. **The lanes.** Re-run the two-app line and narrate what the viewer just saw: the background lane never touches the pointer (Apple events, browser, files, shell); the screen lane waits for the lease; your own keystroke pauses Jarhead's hands for 1.5 s — type something mid-task to prove it.
3. **Billing.** Point at the meter. Press Pause: the meter stops. Press Go: a new session picks up the conversation. Pause and Stop both close the socket because GPT-Live-1 bills per second of open session.
4. **Self-edit.** "Jarhead, make your greeting one word shorter." Show the worktree appear under `~/.jarhead/worktrees`, the checks run (typecheck, tests, Swift build), the rails it names, and that nothing applies until you say so. This is the part nobody else has.
5. **One Jarhead.** `pnpm build:mac` while the app runs: the install updates in place, the inode line, the strict verify, the Dock audit. `pnpm jarhead doctor`.

## What not to demo

- Anything that needs Full Disk Access unless it is granted; the EPERM line is honest but not a demo.
- A destructive verb you actually want done; the handshake is the point, the deletion is not.
- More than three threads beside the main one. Main + 3 is the cap on purpose.
