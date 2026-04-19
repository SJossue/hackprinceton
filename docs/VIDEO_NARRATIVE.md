# Rewind — Video Narrative (Tiger Mascot Pitch)

**For:** generating a ~60–90 second animated video presentation.
**Mascot:** HackPrinceton tiger — the calm, attentive guardian of the scene.
**Tone:** warm and emotionally grounded, not techno-dazzle. This is a product about *people*, not gadgets.

---

## The elevator line

> **"Your home has a memory. Just ask."**

Rewind is an ambient memory device for a physical space. It watches, remembers *events* — not video — and answers natural-language questions about what happened in the room over the last hours or days. Video never leaves the wall; only text crosses the network. It's a privacy-first, voice-friendly second memory for anyone whose days run faster than their recall: elderly family members, people with ADHD, busy caregivers, lab researchers, safety-conscious homes.

---

## The problem — open the video here

Open on a warm living room. Morning light. A medicine bottle on a desk, keys, a phone. A woman in her sixties moves through the scene — she's looking for something. Pauses. Checks one pocket. Looks at the counter. Something is bothering her.

**Narration (tiger, off-camera at first, gentle):**

> *"Mom misplaced her keys again. It's been happening more lately. Her daughter Sarah worries — is it normal? Is it not? She can't be here all the time."*

The woman finds a sticky note. Can't read her own handwriting from earlier. Sighs.

> *"Cameras feel invasive. Reminders get ignored. And the family feels the worry creep in."*

---

## The tiger reveals Rewind

The tiger pads softly into frame — curious, ears forward, watchful. Not cartoony; quiet and present. Think "family guardian," not "mascot slapstick." It stops near a small device mounted on the wall — a Raspberry Pi + camera tucked into a neat cardboard enclosure, a tiny phone nearby showing an ambient breathing dot.

**Tiger (speaking directly to the camera now, warm):**

> *"This is Rewind. It watches, but it doesn't record. It remembers what happened — not what it saw. And when you need to know, you just ask."*

Visual: a subtle graphic animates behind the device. A camera icon → a squiggly arrow → a tiny list of "events" (bottle placed on desk 8:02 AM, keys picked up 9:13 AM). Emphatic caption: **"video never leaves this wall."**

---

## The magic moment — mom talks to Rewind

The woman walks up to the device. The ambient display on the phone shifts from a quiet breathing dot → a listening ring.

**Mom:** *"Where did I put my keys?"*

The display shifts to a thinking spinner. The tiger glances toward it, eyes softening, listening.

A beat. The display shows a large line of text — and a calm human voice (ElevenLabs) reads it aloud:

> *"You picked up your keys from the desk at 10 PM yesterday. I haven't seen where you set them down since — they should be with you."*

Mom smiles. Looks in her coat pocket. Finds them.

**Tiger (gently, to camera):**

> *"Rewind answers from what it actually saw. It never invents a story. And if it doesn't know, it says so."*

---

## The ambient beat — when Rewind notices first

Time jump. Afternoon light. Kitchen empty. The device's ambient display is back to idle — just the breathing dot. Somewhere quietly in the background, the Pi is humming.

Suddenly the display turns red: **alert state**. The tiger's head turns. The same calm voice speaks, now with a note of concern:

> *"Mom missed her morning medication. Scheduled for 8 AM — it's been two hours since the window closed."*

Cut to Sarah (the daughter), at work, across town. Her phone buzzes with a calm text message — not a scary medical alert, a warm one:

> *"Hi Sarah, just a heads-up that this morning's 8:00 medication hasn't been taken yet. When you get a chance, could you check in and help get it sorted? Thanks, love you."*

Sarah smiles softly. Types: *"On it."*

**Tiger:**

> *"Rewind doesn't wait to be asked. When it notices something that matters, it speaks up — in a way that feels like a friend, not a hospital."*

Visual: a caption appears crisply — **"drafted by AI, reviewed by family."** The implication is that the warmth is real, not manufactured.

---

## How it works — kept simple for the video

Quick stylized architectural beat, ~10 seconds:

- **A small camera on the wall** (drawn as a Pi with the Brio webcam) — watches but doesn't store video.
- **A compute hub nearby** (drawn as a laptop) — runs the AI. Two reasoning engines work together: **K2 Think V2** for deep reasoning, **Claude** as a safety net. Both answer in the same warm voice.
- **A phone-stand display** (drawn as a phone propped up) — lights up when Rewind is listening, thinking, or answering.
- **Video frames never leave the room.** The tiger looks directly into the camera and taps the wall next to the Pi for emphasis.

The tiger explains, casual:

> *"The camera sees everything. The device understands *events* — object placed, person entered, pills taken. Only those text-events cross the network. Not a single second of video."*

---

## The three "who this is for" beats

Fast montage, ~15 seconds — three short vignettes, each with the tiger briefly present in frame:

1. **Elderly care** — Mom finds her keys with Rewind's help. Sarah sleeps easier.
2. **ADHD support** — a college student asks Rewind, *"When did I last take my ADHD meds?"* — Rewind answers: *"Around 9 AM this morning — you took them right after you put your phone on the desk."*
3. **Lab / home safety** — a grad student asks, *"Did anyone come into the lab last night?"* — Rewind: *"One person entered at 10:43 PM and left at 11:17 PM. They placed a book on the chair before leaving."*

**Tiger (closing):**

> *"Rewind is a second memory for anyone whose days run faster than their recall. It's ambient. It's private. And it's finally possible."*

---

## The close

The tiger settles in front of the Pi device, curls down comfortably — guarding it, or maybe just resting near something it trusts.

The final screen fades in:

> **REWIND**
>
> *Your home has a memory. Just ask.*
>
> HackPrinceton 2026 — [team lead + teammates credit line]

Music gently resolves. The tiger blinks, once, at the camera. Cut to black.

---

## Notes for the animator

**Tiger character direction:**
- Adult tiger, calm, attentive. Think "loyal and wise," not "mascot energy."
- Silent presence most of the time; its voice narrates, but the tiger doesn't talk on-camera every moment.
- Eyes matter: the tiger reacts (listens, glances, softens) to what the humans and the device are doing. It's a character, not just a logo.
- Can be stylized (clean vector / storybook) — doesn't need to be photorealistic.

**Pacing:**
- Target 60–90 seconds total.
- Open on emotional hook (~15 s): mom can't find keys.
- Reveal Rewind (~10 s).
- Magic moment (~15 s).
- Ambient/proactive beat with Sarah (~15 s).
- How it works architectural beat (~10 s).
- Who-this-is-for montage (~15 s).
- Close (~5 s).

**Color palette:**
- Warm, residential: amber kitchen light, soft greens, gentle desaturated pastels.
- Rewind device accents: emerald green (matches the UI) for ambient "alive" states.
- Alert state: muted red, not medical-emergency red.

**Sound:**
- Ambient room sound, not music-heavy.
- ElevenLabs voice lines delivered verbatim (they're in the script above — these are actual answers Rewind produces).
- Soft UI chimes on state transitions.
- Music swells only at reveal and close.

**What not to do:**
- No spinning holograms, tech-bro neon grids, or "AI brain" imagery.
- No "loading bars" or typing animations — Rewind's answers feel instant in the live demo; animate them the same way.
- No crying-mom-finds-Alzheimer's-pamphlet moment. The tone is warm, not tragic.
- No "surveillance eye" visual. The camera on the wall should feel like a picture frame, not a security cam.

**Privacy signaling (important):**
- At the "video never leaves" moment, animate the frame clearly: camera → device → ONLY a short text line crosses the network boundary → arrow to the cloud.
- This is the core pitch. Make it visually unmissable for ~2 seconds.

**Real product assets to use:**
- Actual screenshots of the dashboard (Ariji's Tailwind UI — emerald-accent, dark theme).
- Real ElevenLabs voice reading the quoted lines.
- The actual Pi + Brio camera as the physical device.
- The segmented model selector (Auto / K2 / Claude) shown during the "two reasoning engines" beat.

---

## One-sentence summaries for different channels

- **Devpost subtitle**: An ambient wall-mounted memory device that remembers events, not video — ask it anything about what just happened in the room.
- **Pitch slide**: Privacy-first episodic memory for elderly care, ADHD, and home safety. K2 Think V2 + Claude reasoning, zero video cloud storage.
- **Tweet-length**: Your home has a memory. Just ask. 🐅 Rewind at HackPrinceton 2026.
