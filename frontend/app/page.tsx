"use client";

/**
 * Recall — Command Center  ·  "Your home has a memory. Just ask."
 *
 * Backend:
 *   GET  /events?limit=N → EventRow[]   WS /ws/events → stream
 *   POST /query {question} → Answer     POST /agent/check → Alert[]
 *   POST /agent/action {action} → 200   GET /thumb/<path> → JPEG
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, AlertTriangle, CheckCircle2, Clock,
  Eye, EyeOff, MapPin, Mic, MicOff, Moon, Send, Sun,
  Users, Volume2, Wifi, WifiOff, Zap,
} from "lucide-react";

// ── Config ──────────────────────────────────────────────────────────────────

const API_BASE = (process.env.NEXT_PUBLIC_REWIND_API ?? "http://localhost:8000").replace(/\/$/, "");
const WS_URL = API_BASE.replace(/^http/, "ws") + "/ws/events";

// ── Types ────────────────────────────────────────────────────────────────────

type EventRow = {
  id: number; ts: number; event_type: string; object: string;
  track_id?: number | null; confidence?: number | null;
  thumb_path?: string | null; location?: string | null;
  room?: string | null;
  location_x?: number | null; location_y?: number | null;
};
type Answer = { answer: string; confidence: "high" | "medium" | "low"; event_ids: number[]; _model?: string };
type Alert = {
  severity: "info" | "warn" | "urgent"; title: string; body: string;
  suggested_action?: { type: string; to_name?: string; draft?: string } | null;
};

// ── Mock data ────────────────────────────────────────────────────────────────

const MOCK_OBJECTS = ["keys", "phone", "pill bottle", "wallet", "water bottle", "TV remote", "glasses", "notebook", "charger", "book"];
const MOCK_ETYPES = ["object_placed", "object_removed", "person_entered_frame", "person_left_frame", "object_picked_up", "medication_taken"];
const MOCK_ROOMS = ["Living Room", "Kitchen", "Bedroom", "Bathroom", "Bedroom 2"];
let _mockId = 1000;

const makeMock = (): EventRow => ({
  id: _mockId++, ts: Math.floor(Date.now() / 1000),
  event_type: MOCK_ETYPES[Math.floor(Math.random() * MOCK_ETYPES.length)],
  object: MOCK_OBJECTS[Math.floor(Math.random() * MOCK_OBJECTS.length)],
  room: MOCK_ROOMS[Math.floor(Math.random() * MOCK_ROOMS.length)],
  location_x: Math.random(), location_y: Math.random(), thumb_path: null,
});

const SEEDS: EventRow[] = Array.from({ length: 28 }, (_, i) => ({
  id: i + 1, ts: Math.floor(Date.now() / 1000) - (28 - i) * 190 - Math.floor(Math.random() * 80),
  event_type: MOCK_ETYPES[i % MOCK_ETYPES.length],
  object: MOCK_OBJECTS[i % MOCK_OBJECTS.length],
  room: MOCK_ROOMS[i % MOCK_ROOMS.length],
  location_x: Math.random(), location_y: Math.random(), thumb_path: null,
}));

const MOCK_QA: [string, string][] = [
  ["keys", "Your keys were placed on the counter near the sink at 3:14 PM — about 47 minutes ago."],
  ["medication", "Yes. The pill bottle was picked up at 8:02 AM. You opened it and drank water. First time since yesterday morning."],
  ["pill", "Yes. The pill bottle was picked up at 8:02 AM. You opened it and drank water. First time since yesterday morning."],
  ["meds", "Yes. The pill bottle was picked up at 8:02 AM. You opened it and drank water. First time since yesterday morning."],
  ["someone", "A person entered the frame at 2:47 PM — approximately 64 minutes ago."],
  ["phone", "Your phone was last seen on the left side of the desk at 4:11 PM, about 22 minutes ago."],
  ["wallet", "Your wallet was placed on the kitchen counter at 1:32 PM — about 2 hours ago."],
];

// ── Utilities ────────────────────────────────────────────────────────────────

const fmtTime = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtRelative = (ts: number) => {
  const d = Math.floor(Date.now() / 1000) - ts;
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  return `${Math.floor(d / 3600)}h ago`;
};

function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.0; u.pitch = 1.0;
  const pref = window.speechSynthesis.getVoices().find(v => /Samantha|Jenny|Google US English|Microsoft Aria/i.test(v.name));
  if (pref) u.voice = pref;
  window.speechSynthesis.speak(u);
}

type SRClass = new () => {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: (e: any) => void; onend: () => void; onerror: (e: any) => void; start: () => void; stop: () => void
};
const getSR = (): SRClass | null =>
  typeof window === "undefined" ? null :
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;

const thumbURL = (p: string) => `${API_BASE}/thumb/${p}`;

// ── Event metadata ───────────────────────────────────────────────────────────

const EVENT_LABEL: Record<string, string> = {
  object_placed: "placed", object_removed: "removed", object_picked_up: "picked up",
  object_moved: "moved",
  person_entered: "entered", person_left: "left",
  person_entered_frame: "entered", person_left_frame: "left",
  medication_taken: "medication", action_detected: "action",
};
const EVENT_COLOR: Record<string, string> = {
  object_placed: "#B8743F", object_removed: "#B8743F",
  object_picked_up: "#B8743F", object_moved: "#B8743F",
  person_entered: "#9A6F5E", person_left: "#9A6F5E",
  person_entered_frame: "#9A6F5E", person_left_frame: "#9A6F5E",
  medication_taken: "#7C8D65", action_detected: "#B8743F",
};
const ACTION_LABEL: Record<string, string> = {
  taking_pills: "medication", using_phone: "on phone", reading: "reading",
};
const CONF_COLOR: Record<string, string> = { high: "#9BAD82", medium: "#B8743F", low: "#C66548" };
const CONF_LABEL: Record<string, string> = { high: "High confidence", medium: "Medium", low: "Low confidence" };

// Backend canonical events differ from the legacy mock vocabulary. Keep both
// working so the UI stays correct whether data comes from WS / GET /events
// (real capture_local.py output) or startMock() (fallback when offline).
const isMedEvent = (e: EventRow) =>
  e.event_type === "medication_taken" ||
  (e.event_type === "action_detected" && e.object === "taking_pills");
const isPersonEvent = (e: EventRow) =>
  e.event_type === "person_entered" || e.event_type === "person_left" ||
  e.event_type === "person_entered_frame" || e.event_type === "person_left_frame";

// Map backend's spatial-grounding string ("the desk" / "the chair") to
// normalized [0,1] canvas coords. Falls through to a deterministic id-hash
// scatter so every event still shows on the heatmap.
const LOCATION_COORDS: Record<string, [number, number]> = {
  "the desk": [0.32, 0.62],
  "the chair": [0.72, 0.70],
};
function eventCoords(e: EventRow): [number, number] {
  if (e.location_x != null && e.location_y != null) return [e.location_x, e.location_y];
  if (e.location && LOCATION_COORDS[e.location]) return LOCATION_COORDS[e.location];
  const h = ((e.id * 2654435761) >>> 0);
  return [((h & 0xffff) / 0xffff) * 0.8 + 0.1, (((h >>> 16) & 0xffff) / 0xffff) * 0.7 + 0.15];
}

const PRESETS = [
  { label: "Did I take my medication today?", icon: "💊", hero: true },
  { label: "Where did I leave my keys?", icon: "🔑", hero: false },
  { label: "When did someone last come in?", icon: "🚶", hero: false },
  { label: "Where is my phone?", icon: "📱", hero: false },
];

// ── Hooks ────────────────────────────────────────────────────────────────────

function useTypewriter(text: string, speed = 14) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => {
    setDisplayed(""); setDone(false);
    if (!text) return;
    let i = 0;
    const t = setInterval(() => {
      i++; setDisplayed(text.slice(0, i));
      if (i >= text.length) { clearInterval(t); setDone(true); }
    }, speed);
    return () => clearInterval(t);
  }, [text, speed]);
  return { displayed, done };
}

// ── Sub-components ───────────────────────────────────────────────────────────

function AuroraOrbs({ dark }: { dark: boolean }) {
  // Warm atmospheric wash — paper grain + slow-drifting tea stains. Light
  // mode uses a second render pass over the body::before grain; dark mode
  // deepens the warmth with amber candlelight.
  const tones = dark
    ? [
      { w: 520, h: 520, color: "rgba(184,116,63,0.09)", top: -120, left: -120, anim: "orbFloat1 42s ease-in-out infinite" },
      { w: 420, h: 420, color: "rgba(154,111,94,0.07)", bottom: -100, right: -80, anim: "orbFloat2 55s ease-in-out infinite" },
    ]
    : [
      { w: 560, h: 560, color: "rgba(184,116,63,0.07)", top: -140, left: "-8%", anim: "orbFloat1 48s ease-in-out infinite" },
      { w: 460, h: 460, color: "rgba(124,141,101,0.06)", bottom: -120, right: "-6%", anim: "orbFloat2 62s ease-in-out infinite" },
    ];
  return (
    <div aria-hidden style={{ position: "fixed", inset: 0, overflow: "hidden", pointerEvents: "none", zIndex: 0 }}>
      {tones.map((o, i) => (
        <div key={i} style={{
          position: "absolute", width: o.w, height: o.h, borderRadius: "50%",
          background: `radial-gradient(circle, ${o.color} 0%, transparent 70%)`,
          filter: "blur(80px)", animation: o.anim,
          ...(o.top !== undefined ? { top: o.top } : {}),
          ...(o.bottom !== undefined ? { bottom: o.bottom } : {}),
          ...(o.left !== undefined ? { left: o.left } : {}),
          ...(o.right !== undefined ? { right: o.right } : {}),
        }} />
      ))}
    </div>
  );
}

function LiveDot({ active }: { active: boolean }) {
  return (
    <span className="relative inline-flex" style={{ width: 10, height: 10 }}>
      <span className="absolute inset-0 rounded-full"
        style={{ background: active ? "var(--emerald)" : "var(--text-muted)" }} />
      {active && <span className="absolute inset-0 rounded-full"
        style={{ background: "var(--emerald)", animation: "pingSlow 2s ease-out infinite", opacity: 0.6 }} />}
    </span>
  );
}

// ── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  label, value, sub, icon: Icon, accent, glow, active,
}: {
  label: string; value: string | number; sub?: string;
  icon: React.ElementType; accent: string; glow: string; active?: boolean;
}) {
  return (
    <div className="card" style={{
      borderColor: active ? `${accent}55` : undefined,
      padding: "26px 28px",
      boxShadow: active ? `0 1px 0 rgba(42,31,21,0.04) inset, 0 18px 50px -28px ${glow}` : undefined,
      position: "relative",
      overflow: "hidden",
    }}>
      {/* Soft accent wash in the corner instead of a hard stripe */}
      <div aria-hidden style={{
        position: "absolute", top: -40, right: -40, width: 160, height: 160, borderRadius: "50%",
        background: `radial-gradient(circle, ${glow} 0%, transparent 65%)`,
        opacity: active ? 0.9 : 0.35,
        pointerEvents: "none",
      }} />

      {/* Icon + label row */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, position: "relative" }}>
        <div style={{
          width: 42, height: 42, borderRadius: "50%", display: "flex",
          alignItems: "center", justifyContent: "center",
          background: `${accent}1c`,
          border: `1px solid ${accent}33`,
        }}>
          <Icon size={18} color={accent} />
        </div>
        <span style={{
          fontFamily: "'Manrope',sans-serif",
          fontSize: "0.82rem", fontWeight: 600,
          letterSpacing: "0.01em",
          color: "var(--ink-soft)",
        }}>{label}</span>
      </div>

      {/* Value — Fraunces, editorial scale */}
      <div style={{
        fontFamily: "'Fraunces',Georgia,serif",
        fontVariationSettings: '"opsz" 144, "SOFT" 100',
        fontSize: "2.4rem",
        fontWeight: 420, lineHeight: 1.05,
        color: active ? accent : "var(--ink)",
        letterSpacing: "-0.02em",
        position: "relative",
      }} className="animate-count-up">
        {value}
      </div>

      {/* Sub-label — warm prose, not mono log */}
      {sub && (
        <div style={{
          marginTop: 8, fontFamily: "'Fraunces',Georgia,serif",
          fontStyle: "italic", fontWeight: 400,
          fontSize: "0.88rem", color: active ? `${accent}` : "var(--ink-mute)",
          position: "relative",
        }}>
          {sub}
        </div>
      )}
    </div>
  );
}

// ── Home layout ──────────────────────────────────────────────────────────────

// 2-bedroom floor plan. Coordinates are in a 0-100 × 0-60 viewBox so the SVG
// scales cleanly to any container width. Each room is a labelled rect; events
// tagged with `room === name` light that room up proportionally to recency.
type Room = {
  name: string;
  x: number; y: number; w: number; h: number;
  labelOffset?: [number, number]; // optional extra offset for label placement
};
const ROOMS: Room[] = [
  { name: "Living Room", x: 2, y: 2, w: 58, h: 28 },
  { name: "Kitchen", x: 60, y: 2, w: 38, h: 28 },
  { name: "Bedroom", x: 2, y: 30, w: 30, h: 28 },
  { name: "Bathroom", x: 32, y: 30, w: 30, h: 28 },
  { name: "Bedroom 2", x: 62, y: 30, w: 36, h: 28 },
];

type RoomStats = {
  count: number;
  mostRecentTs: number;      // 0 when no events
  mostRecentEvent: EventRow | null;
  hasMed: boolean;
  hasPerson: boolean;
};

function computeRoomStats(events: EventRow[]): Map<string, RoomStats> {
  const out = new Map<string, RoomStats>();
  for (const r of ROOMS) {
    out.set(r.name, { count: 0, mostRecentTs: 0, mostRecentEvent: null, hasMed: false, hasPerson: false });
  }
  for (const e of events) {
    if (!e.room) continue;
    const s = out.get(e.room);
    if (!s) continue; // unknown room label — skip
    s.count += 1;
    if (e.ts > s.mostRecentTs) {
      s.mostRecentTs = e.ts;
      s.mostRecentEvent = e;
    }
    if (isMedEvent(e)) s.hasMed = true;
    if (isPersonEvent(e)) s.hasPerson = true;
  }
  return out;
}

// Deterministic scatter inside a room rect, keyed on event id so dots stay put
// across re-renders. Leaves a small inset so dots don't graze room walls.
function dotInRoom(r: Room, id: number): [number, number] {
  const h = (id * 2654435761) >>> 0;
  const nx = (h & 0xffff) / 0xffff;
  const ny = ((h >>> 16) & 0xffff) / 0xffff;
  const inset = 3;
  return [
    r.x + inset + nx * (r.w - inset * 2),
    r.y + inset + ny * (r.h - inset * 2),
  ];
}

function HomeLayout({ events }: { events: EventRow[] }) {
  const stats = computeRoomStats(events);
  const now = Math.floor(Date.now() / 1000);
  const medCount = events.filter(isMedEvent).length;
  // Events sorted newest-first, capped for dot layer to keep SVG light
  const recent = [...events].sort((a, b) => b.ts - a.ts).slice(0, 30);

  // How "active" is a room right now — exponential decay on age-of-most-recent.
  // Under 2 min → full glow; 15 min → ~25%; 1 h → near zero.
  const activity = (s: RoomStats) => {
    if (!s.mostRecentTs) return 0;
    const age = Math.max(0, now - s.mostRecentTs);
    return Math.exp(-age / 900); // half-life ~10 min
  };

  // Ink tones for SVG text — follow the theme for readability.
  const inkTone = "42,31,21"; // ink RGB
  return (
    <div>
      <div style={{ marginBottom: 18, display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
        <div>
          <div style={{
            fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic",
            fontSize: "0.78rem", color: "var(--amber)", letterSpacing: "0.08em",
            textTransform: "uppercase", marginBottom: 4,
          }}>Your home, just now</div>
          <h2 style={{
            fontFamily: "'Fraunces',Georgia,serif", fontSize: "1.55rem",
            fontWeight: 420, margin: 0, lineHeight: 1.1, letterSpacing: "-0.015em",
            fontVariationSettings: '"opsz" 144, "SOFT" 100',
          }}>
            Where things are happening
          </h2>
        </div>
        <div style={{ display: "flex", gap: 18 }}>
          {[
            ["124,141,101", "medication"],
            ["154,111,94", "someone home"],
            ["184,116,63", "objects & activity"],
          ].map(([rgb, l]) => (
            <div key={l} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{
                width: 10, height: 10, borderRadius: "50%",
                background: `rgb(${rgb})`,
                boxShadow: `0 0 0 3px rgba(${rgb},0.18)`,
                display: "inline-block",
              }} />
              <span style={{
                fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic",
                fontSize: "0.85rem", color: "var(--ink-soft)",
              }}>{l}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{
        borderRadius: 20, overflow: "hidden", position: "relative",
        border: "1px solid var(--border)",
        background: "linear-gradient(180deg, var(--surface-2), color-mix(in oklab, var(--surface-2) 75%, var(--surface-3)))",
        boxShadow: "0 1px 0 rgba(42,31,21,0.04) inset, 0 14px 40px -28px rgba(42,31,21,0.22)",
      }}>
        <svg viewBox="0 0 100 60" preserveAspectRatio="none" style={{ display: "block", width: "100%", height: 340 }}>
          {/* Outer wall — drawn walls of the "floor plan". */}
          <rect x={1.2} y={1.2} width={97.6} height={57.6} rx={1.4}
            fill="rgba(42,31,21,0.02)"
            stroke={`rgba(${inkTone},0.28)`}
            strokeWidth={0.45} />

          {/* Rooms */}
          {ROOMS.map(r => {
            const s = stats.get(r.name)!;
            const a = activity(s);
            const color = s.hasMed ? "124,141,101" : s.hasPerson ? "154,111,94" : "184,116,63";
            const fillAlpha = 0.035 + a * 0.28;
            const strokeAlpha = 0.20 + a * 0.55;
            return (
              <g key={r.name}>
                <rect
                  x={r.x} y={r.y} width={r.w} height={r.h} rx={0.9}
                  fill={s.count > 0 ? `rgba(${color},${fillAlpha})` : "rgba(255,252,245,0.35)"}
                  stroke={s.count > 0 ? `rgba(${color},${strokeAlpha})` : `rgba(${inkTone},0.20)`}
                  strokeWidth={0.4}
                />
                {/* Pulsing ring on the active room */}
                {a > 0.15 && (
                  <rect
                    x={r.x} y={r.y} width={r.w} height={r.h} rx={0.9}
                    fill="none"
                    stroke={`rgba(${color},${a * 0.7})`}
                    strokeWidth={0.7}
                  >
                    <animate attributeName="stroke-opacity"
                      values={`${a * 0.7};${a * 0.22};${a * 0.7}`}
                      dur="2.4s" repeatCount="indefinite" />
                  </rect>
                )}
                {/* Room name — serif, like a label on a blueprint */}
                <text
                  x={r.x + r.w / 2} y={r.y + 5.4}
                  textAnchor="middle"
                  fontSize={2.6}
                  fontFamily="Fraunces, Georgia, serif"
                  fontWeight={500}
                  fontStyle="italic"
                  fill={`rgba(${inkTone},${0.70 + a * 0.25})`}
                >{r.name}</text>
                {/* Event count */}
                {s.count > 0 && (
                  <text
                    x={r.x + r.w / 2} y={r.y + r.h - 6.8}
                    textAnchor="middle"
                    fontSize={1.8}
                    fontFamily="Manrope, sans-serif"
                    fontWeight={500}
                    fill={`rgba(${color},${0.55 + a * 0.4})`}
                  >{s.count} {s.count === 1 ? "moment" : "moments"}</text>
                )}
                {/* Most recent object label */}
                {s.mostRecentEvent && (
                  <text
                    x={r.x + r.w / 2} y={r.y + r.h - 3.6}
                    textAnchor="middle"
                    fontSize={1.95}
                    fontFamily="Fraunces, Georgia, serif"
                    fontStyle="italic"
                    fill={`rgba(${inkTone},${0.50 + a * 0.35})`}
                  >“{s.mostRecentEvent.object.slice(0, 18)}”</text>
                )}
              </g>
            );
          })}

          {/* Per-event dots scattered inside their room */}
          {recent.map((e, idx) => {
            if (!e.room) return null;
            const room = ROOMS.find(r => r.name === e.room);
            if (!room) return null;
            const [cx, cy] = dotInRoom(room, e.id);
            const med = isMedEvent(e), per = isPersonEvent(e);
            const color = med ? "124,141,101" : per ? "154,111,94" : "184,116,63";
            const alpha = Math.max(0.18, 1 - idx * 0.05);
            const r = med ? 0.95 : 0.8;
            return (
              <g key={e.id}>
                <circle cx={cx} cy={cy} r={r * 1.7} fill={`rgba(${color},${alpha * 0.18})`} />
                <circle cx={cx} cy={cy} r={r} fill={`rgba(${color},${alpha})`} />
              </g>
            );
          })}
        </svg>

        {medCount > 0 && (
          <div style={{
            position: "absolute", top: 16, left: 18, display: "flex", alignItems: "center", gap: 8,
            padding: "6px 14px 6px 12px", borderRadius: 999,
            background: "color-mix(in oklab, var(--surface-1) 80%, var(--emerald))",
            border: "1px solid var(--border-em)",
            fontSize: "0.85rem", color: "var(--emerald)",
            fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic", fontWeight: 420,
            boxShadow: "0 6px 18px -8px rgba(124,141,101,0.4)",
          }}>
            <CheckCircle2 size={14} /> medication, {medCount === 1 ? "once" : `${medCount} times`} today
          </div>
        )}
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

// Mock-data sources (SEEDS + periodic makeMock) are strictly opt-in. Without
// this env flag, the dashboard shows only what the real backend returns — the
// empty state ("The house is still quiet.") renders when the DB is empty or
// when the backend is unreachable. Judges + demo operators must not confuse
// fake activity for real captures.
const MOCK_MODE = process.env.NEXT_PUBLIC_REWIND_MOCK_MODE === "1";

export default function Page() {
  const [events, setEvents] = useState<EventRow[]>(MOCK_MODE ? SEEDS : []);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [shutterClosed, setShutterClosed] = useState(false);
  const [newEventId, setNewEventId] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [agentChecked, setAgentChecked] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [dark, setDark] = useState(false);
  // Per-request model selector. "auto" lets the backend route by default
  // (K2 primary / Claude failover). "k2" / "claude" force the path so
  // judges can watch both reasoning engines side-by-side on the same query.
  const [modelPref, setModelPref] = useState<"auto" | "k2" | "claude">("auto");

  // Apply theme to <html> and persist
  useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("rewind-theme") : null;
    if (saved === "dark") setDark(true);
  }, []);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    localStorage.setItem("rewind-theme", dark ? "dark" : "light");
  }, [dark]);

  const recognitionRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mockRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectDelay = useRef(1000);
  const eventsRef = useRef<EventRow[]>(MOCK_MODE ? SEEDS : []);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { eventsRef.current = events; }, [events]);

  const { displayed: typedAnswer, done: typingDone } = useTypewriter(answer?.answer ?? "", 13);

  const pushEvent = useCallback((ev: EventRow) => {
    setEvents(prev => { const next = [ev, ...prev].slice(0, 100); eventsRef.current = next; return next; });
    setNewEventId(ev.id);
    setTimeout(() => setNewEventId(null), 2000);
  }, []);

  // Only fires when MOCK_MODE is set. Default (live demo) does nothing here.
  const startMock = useCallback(() => {
    if (!MOCK_MODE || mockRef.current) return;
    mockRef.current = setInterval(() => pushEvent(makeMock()), 3500);
  }, [pushEvent]);

  const connectWS = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    ws.onopen = () => { setConnected(true); reconnectDelay.current = 1000; if (mockRef.current) { clearInterval(mockRef.current); mockRef.current = null; } };
    ws.onmessage = msg => { if (typeof msg.data === "string" && msg.data.trim() === "pong") return; try { const ev: EventRow = JSON.parse(msg.data); if (typeof ev.id === "number") pushEvent(ev); } catch { } };
    ws.onerror = () => { setConnected(false); startMock(); };
    ws.onclose = () => { setConnected(false); const d = Math.min(reconnectDelay.current, 30000); reconnectDelay.current = d * 2; setTimeout(connectWS, d); };
  }, [pushEvent, startMock]);

  useEffect(() => {
    fetch(`${API_BASE}/events?limit=80`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then((data: EventRow[]) => {
        // Always replace with what the backend says — including an empty array.
        // A real-but-empty DB must render the empty state, not linger on SEEDS.
        if (Array.isArray(data)) { setEvents(data); eventsRef.current = data; }
        setConnected(true);
      })
      .catch(() => startMock());  // no-op unless MOCK_MODE is set
    connectWS();
    const ping = setInterval(() => { if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send("ping"); }, 15000);
    return () => { clearInterval(ping); wsRef.current?.close(); if (mockRef.current) clearInterval(mockRef.current); };
  }, [connectWS, startMock]);

  useEffect(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    }
  }, []);

  const ask = useCallback(async (q?: string) => {
    const query = (q ?? question).trim();
    if (!query) return;
    setLoading(true); setAnswer(null);
    // Only send the `model` field when the user explicitly picked one.
    // Omitting it on "auto" lets the backend's default routing (which
    // honors REWIND_DEMO_MODE and k2_configured) take over.
    const body: { question: string; model?: "k2" | "claude" } = { question: query };
    if (modelPref !== "auto") body.model = modelPref;
    try {
      const r = await fetch(`${API_BASE}/query`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error();
      const data: Answer = await r.json();
      setAnswer(data); speak(data.answer);
    } catch {
      const lower = query.toLowerCase();
      const matched = MOCK_QA.find(([k]) => lower.includes(k));
      const ans = matched?.[1] ?? "I didn't catch that in recent events. Try rephrasing, or check the device is watching.";
      setAnswer({ answer: ans, confidence: matched ? "high" : "low", event_ids: matched ? [42, 43] : [], _model: "mock" });
      speak(ans);
    } finally { setLoading(false); }
  }, [question, modelPref]);

  // Fire-and-forget push to the ambient display channel. The /status page
  // (phone stand) is a pure subscriber — morphing its particle cloud based
  // on these state events. Failures are swallowed so a flaky backend never
  // blocks voice input on the main page.
  function pushAmbientState(state: "idle" | "listening" | "thinking" | "answer" | "alert", text?: string) {
    fetch(`${API_BASE}/internal/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(text ? { state, text } : { state }),
    }).catch(() => { });
  }

  function toggleListen() {
    const SR = getSR();
    if (!SR) { alert("Voice input works in Chrome / Edge. You can also type."); return; }
    if (listening && recognitionRef.current) { recognitionRef.current.stop(); return; }
    const recog = new SR();
    recog.continuous = false; recog.interimResults = false; recog.lang = "en-US";
    recog.onresult = (e: any) => { const t = e.results[0][0].transcript; setQuestion(t); setTimeout(() => ask(t), 100); };
    recog.onend = () => { setListening(false); pushAmbientState("idle"); };
    recog.onerror = () => { setListening(false); pushAmbientState("idle"); };
    recognitionRef.current = recog; setListening(true);
    pushAmbientState("listening");
    recog.start();
  }

  async function checkAgent() {
    setAgentChecked(true);
    try {
      const r = await fetch(`${API_BASE}/agent/check`, { method: "POST" });
      if (!r.ok) throw new Error();
      setAlerts(await r.json());
    } catch {
      setAlerts([{
        severity: "urgent", title: "Evening dose is 6 hours overdue",
        body: "The pill bottle hasn't been touched since 8:02 AM. Evening dose is usually taken by 9 PM.",
        suggested_action: { type: "sms", to_name: "Mom", draft: "Hey Mom, just checking — did you take your evening medication? Recall noticed the bottle hasn't been opened since this morning." },
      }]);
    }
  }

  function resolveThumb(ans: Answer): string | null {
    if (!ans.event_ids?.length) return null;
    const ev = eventsRef.current.find(e => ans.event_ids.includes(e.id));
    return ev?.thumb_path ? thumbURL(ev.thumb_path) : null;
  }

  // Derived stats
  const totalEvents = events.length;
  const medDoses = events.filter(isMedEvent).length;
  const lastPersonEv = events.find(isPersonEvent);
  const thumbSrc = answer ? resolveThumb(answer) : null;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <main style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text-primary)" }}>
      <AuroraOrbs dark={dark} />

      <div style={{ position: "relative", zIndex: 1 }} className="animate-fade-in">

        {/* ── HEADER ───────────────────────────────────────────────────────── */}
        <header style={{
          borderBottom: "1px solid var(--border)",
          background: dark ? "rgba(28,22,16,0.78)" : "rgba(245,238,225,0.82)",
          backdropFilter: "blur(22px)", WebkitBackdropFilter: "blur(22px)",
          position: "sticky", top: 0, zIndex: 50,
        }}>
          <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 28px", height: 68, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            {/* Brand — serif wordmark. */}
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <LiveDot active={!shutterClosed} />
              <span style={{
                fontFamily: "'Fraunces',Georgia,serif",
                fontSize: "1.45rem", fontWeight: 450,
                fontVariationSettings: '"opsz" 144, "SOFT" 100',
                letterSpacing: "-0.025em",
                color: "var(--ink)",
              }}>
                Recall
              </span>
              <span aria-hidden style={{
                width: 1, height: 20, background: "var(--border-strong)", margin: "0 2px",
              }} />
              <span style={{
                fontFamily: "'Fraunces',Georgia,serif",
                fontStyle: "italic", fontWeight: 360, fontSize: "0.9rem",
                color: "var(--ink-soft)",
                letterSpacing: "0",
              }}>
                a quiet memory for your home
              </span>
            </div>

            {/* Right side */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {/* Companion ambient display — the phone-stand view */}
              <a href="/status" target="_blank" rel="noopener noreferrer"
                title="Open the phone-stand ambient display"
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "7px 14px", borderRadius: 999,
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic",
                  fontSize: "0.88rem", color: "var(--ink-soft)",
                  textDecoration: "none",
                  transition: "all 0.22s",
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--amber)"; e.currentTarget.style.color = "var(--amber)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--ink-soft)"; }}>
                <span aria-hidden style={{
                  width: 7, height: 7, borderRadius: "50%",
                  background: "var(--amber)",
                  boxShadow: "0 0 0 3px color-mix(in oklab, var(--amber) 22%, transparent)",
                }} />
                ambient display
              </a>

              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 12px", borderRadius: 999,
                background: connected ? "color-mix(in oklab, var(--emerald) 14%, transparent)" : "var(--surface-2)",
                border: `1px solid ${connected ? "var(--border-em)" : "var(--border)"}`,
                fontSize: "0.78rem",
                color: connected ? "var(--emerald)" : "var(--text-muted)",
              }}>
                {connected ? <Wifi size={13} /> : <WifiOff size={13} />}
                <span style={{ fontFamily: "'Manrope',sans-serif", fontWeight: 500 }}>
                  {connected ? "live" : (MOCK_MODE ? "demo data" : "offline")}
                </span>
              </div>

              {/* Theme toggle */}
              <button onClick={() => setDark(d => !d)}
                title={dark ? "Switch to daytime" : "Switch to evening"}
                aria-label={dark ? "Switch to daytime" : "Switch to evening"}
                style={{
                  width: 40, height: 40, borderRadius: 999,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: "var(--surface-2)", border: "1px solid var(--border)",
                  color: "var(--text-secondary)", cursor: "pointer", transition: "all 0.22s",
                  flexShrink: 0,
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--border-strong)"; e.currentTarget.style.color = "var(--text-primary)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-secondary)"; }}>
                {dark ? <Sun size={16} /> : <Moon size={16} />}
              </button>

              <button onClick={() => setShutterClosed(s => !s)}
                aria-label={shutterClosed ? "Resume watching" : "Privacy — close shutter"}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "8px 16px", borderRadius: 999,
                  background: shutterClosed ? "color-mix(in oklab, var(--red) 14%, transparent)" : "var(--surface-2)",
                  border: `1px solid ${shutterClosed ? "color-mix(in oklab, var(--red) 38%, transparent)" : "var(--border)"}`,
                  color: shutterClosed ? "var(--red)" : "var(--text-secondary)",
                  fontSize: "0.85rem", fontWeight: 500,
                  cursor: "pointer", transition: "all 0.22s",
                  fontFamily: "'Manrope',sans-serif",
                }}>
                {shutterClosed ? <EyeOff size={14} /> : <Eye size={14} />}
                {shutterClosed ? "Privacy on" : "Watching"}
              </button>
            </div>
          </div>
        </header>

        {/* ── BODY ─────────────────────────────────────────────────────────── */}
        <div style={{ maxWidth: 1180, margin: "0 auto", padding: "44px 28px 80px", display: "flex", flexDirection: "column", gap: 32 }}>

          {/* ── QUERY HERO ────────────────────────────────────────────────── */}
          <div className="card animate-rise" style={{
            padding: "44px 44px 36px",
            borderColor: inputFocused ? "rgba(184,116,63,0.35)" : undefined,
            boxShadow: inputFocused
              ? "0 1px 0 rgba(42,31,21,0.04) inset, 0 22px 60px -30px rgba(184,116,63,0.35)"
              : undefined,
          }}>
            {/* Heading — the editorial hero. */}
            <div style={{ marginBottom: 28, maxWidth: 840 }}>
              <div className="section-label" style={{ textTransform: "uppercase", letterSpacing: "0.18em", fontSize: "0.68rem", marginBottom: 14, color: "var(--amber)" }}>
                <span className="ornament">Recall</span>
              </div>
              <h1 style={{
                fontFamily: "'Fraunces',Georgia,serif",
                fontSize: "clamp(2.9rem, 6.2vw, 4.6rem)",
                fontWeight: 420,
                fontVariationSettings: '"opsz" 144, "SOFT" 100',
                margin: 0, lineHeight: 1.05, letterSpacing: "-0.02em",
              }}>
                Your home has a memory.<br />
                <em style={{ fontStyle: "italic", fontWeight: 360, color: "var(--amber)" }}>Just ask.</em>
              </h1>
              <p style={{
                marginTop: 16, fontSize: "1.02rem", color: "var(--ink-soft)",
                maxWidth: 540, lineHeight: 1.55,
              }}>
                Recall watches gently over your space and remembers what happens —
                so when you wonder <em style={{ fontStyle: "italic", fontFamily: "'Fraunces',Georgia,serif" }}>where did I leave my keys?</em>
                {" "}or <em style={{ fontStyle: "italic", fontFamily: "'Fraunces',Georgia,serif" }}>did I take my pills?</em> — it can answer.
              </p>
            </div>

            {/* Input row — large, pill-shaped, conversational. */}
            <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
              <input
                ref={inputRef}
                value={question}
                onChange={e => setQuestion(e.target.value)}
                onKeyDown={e => e.key === "Enter" && !loading && ask()}
                onFocus={() => setInputFocused(true)}
                onBlur={() => setInputFocused(false)}
                placeholder="Where did I leave my keys?"
                aria-label="Ask Recall a question"
                style={{
                  flex: "1 1 360px", background: "var(--surface-2)",
                  border: `1.5px solid ${inputFocused ? "var(--amber)" : "var(--border-strong)"}`,
                  borderRadius: 999, padding: "18px 26px",
                  fontSize: "1.1rem", color: "var(--text-primary)",
                  fontFamily: "'Fraunces',Georgia,serif",
                  fontStyle: question ? "normal" : "italic",
                  caretColor: "var(--amber)",
                  outline: "none",
                  boxShadow: inputFocused ? "0 0 0 5px rgba(184,116,63,0.14)" : "none",
                  transition: "border-color 0.2s, box-shadow 0.2s",
                }}
              />
              {/* Ask — primary action, ochre warmth. */}
              <button onClick={() => ask()} disabled={loading || !question.trim()} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "18px 32px", borderRadius: 999,
                background: "var(--amber)", color: "#FBF6EC",
                fontFamily: "'Fraunces',Georgia,serif", fontSize: "1.02rem", fontWeight: 500,
                fontVariationSettings: '"opsz" 144',
                border: "none", cursor: "pointer",
                boxShadow: "0 6px 20px -6px rgba(184,116,63,0.55)",
                opacity: loading || !question.trim() ? 0.45 : 1,
                transition: "all 0.18s cubic-bezier(0.16,1,0.3,1)",
                minWidth: 130, justifyContent: "center",
              }}
                onMouseEnter={e => { if (!loading && question.trim()) { e.currentTarget.style.filter = "brightness(1.06)"; e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 10px 28px -8px rgba(184,116,63,0.7)"; } }}
                onMouseLeave={e => { e.currentTarget.style.filter = "none"; e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "0 6px 20px -6px rgba(184,116,63,0.55)"; }}>
                {loading
                  ? <span className="animate-blink" style={{ letterSpacing: "0.22em", fontSize: "1.2rem" }}>· · ·</span>
                  : <><Send size={17} /> Ask</>}
              </button>
              {/* Voice — cream pill, cordial. */}
              <button onClick={toggleListen}
                title="Speak your question (Chrome or Edge)"
                aria-label={listening ? "Stop listening" : "Ask by voice"}
                style={{
                  width: 62, height: 62, borderRadius: "50%",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: listening ? "var(--red)" : "var(--surface-2)",
                  border: `1.5px solid ${listening ? "var(--red)" : "var(--border-strong)"}`,
                  color: listening ? "#FBF6EC" : "var(--ink-soft)",
                  cursor: "pointer",
                  boxShadow: listening ? "0 0 0 6px rgba(198,101,72,0.18)" : "0 2px 6px -2px rgba(42,31,21,0.12)",
                  transform: listening ? "scale(1.04)" : "scale(1)",
                  transition: "all 0.22s cubic-bezier(0.16,1,0.3,1)",
                  flexShrink: 0,
                }}>
                {listening ? <MicOff size={20} /> : <Mic size={20} />}
              </button>
            </div>

            {listening && (
              <p className="animate-blink" style={{
                fontSize: "0.92rem", color: "var(--red)", marginBottom: 14,
                fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic",
              }}>
                listening — go ahead, say it
              </p>
            )}

            {/* Preset chips — "try asking…" invitation */}
            <div style={{ marginTop: 14 }}>
              <div style={{
                fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic",
                fontSize: "0.95rem", color: "var(--ink-soft)", marginBottom: 10,
              }}>
                or try one of these —
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 10 }}>
                {PRESETS.map(({ label, icon, hero }) => (
                  <button key={label}
                    onClick={() => { setQuestion(label); setTimeout(() => ask(label), 50); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 12,
                      padding: "14px 18px", borderRadius: 999, textAlign: "left", cursor: "pointer",
                      background: hero ? "color-mix(in oklab, var(--surface-1) 70%, var(--amber))" : "var(--surface-2)",
                      border: `1px solid ${hero ? "color-mix(in oklab, var(--amber) 45%, transparent)" : "var(--border)"}`,
                      color: "var(--ink)",
                      fontSize: "0.95rem", fontFamily: "'Fraunces',Georgia,serif",
                      fontStyle: "italic", fontWeight: 420,
                      transition: "all 0.2s cubic-bezier(0.16,1,0.3,1)",
                    }}
                    onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.borderColor = "var(--amber)"; e.currentTarget.style.boxShadow = "0 10px 24px -14px rgba(184,116,63,0.45)"; }}
                    onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.borderColor = hero ? "color-mix(in oklab, var(--amber) 45%, transparent)" : "var(--border)"; e.currentTarget.style.boxShadow = "none"; }}>
                    <span style={{ fontSize: "1.25rem", opacity: 0.85 }}>{icon}</span>
                    <span style={{ flex: 1 }}>{label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Engine selector — demoted to a discreet caption under the hero */}
            <div style={{
              marginTop: 26, paddingTop: 20, borderTop: "1px dashed var(--border)",
              display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
            }}>
              <span style={{
                fontSize: "0.74rem", color: "var(--ink-mute)",
                fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic",
              }}>
                answering with
              </span>
              <div style={{
                display: "flex", gap: 2, background: "var(--surface-2)",
                padding: 3, borderRadius: 999, border: "1px solid var(--border)",
              }}>
                {([
                  { k: "auto" as const, label: "Auto", hint: "K2 primary, Claude failover" },
                  { k: "k2" as const, label: "K2 Think", hint: "force K2 Think V2 — Claude still catches on failure" },
                  { k: "claude" as const, label: "Claude", hint: "force Claude 4.7 — skip K2 entirely" },
                ]).map(({ k, label, hint }) => {
                  const active = modelPref === k;
                  return (
                    <button key={k} onClick={() => setModelPref(k)} title={hint} style={{
                      padding: "5px 14px", borderRadius: 999,
                      fontFamily: "'Manrope',sans-serif", fontSize: "0.78rem", fontWeight: 500,
                      background: active ? "var(--ink)" : "transparent",
                      color: active ? "var(--surface-1)" : "var(--ink-soft)",
                      border: "none", cursor: "pointer",
                      transition: "all 0.2s",
                    }}>
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ── LOADING SKELETON ──────────────────────────────────────────── */}
          {loading && (
            <div className="card animate-slide-up" style={{
              padding: "32px 36px", position: "relative", overflow: "hidden",
            }}>
              <div style={{
                position: "absolute", top: 0, left: "-60%", width: "60%", height: "100%",
                background: "linear-gradient(90deg,transparent,rgba(184,116,63,0.08),transparent)",
                animation: "scanLine 1.8s ease-in-out infinite",
              }} />
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--amber)", animation: "pulseEm 1.6s ease-in-out infinite" }} />
                <span style={{
                  fontSize: "1.05rem", color: "var(--ink-soft)",
                  fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic",
                }}>
                  remembering…
                </span>
              </div>
              {[78, 62, 44].map((w, i) => (
                <div key={i} style={{ height: 14, borderRadius: 999, background: "var(--surface-3)", marginBottom: 12, width: `${w}%`, opacity: 0.75 }} />
              ))}
            </div>
          )}

          {/* ── ANSWER CARD ───────────────────────────────────────────────── */}
          {answer && !loading && (
            <div className="animate-slide-up card" style={{
              background: "linear-gradient(180deg, var(--surface-1), color-mix(in oklab, var(--surface-1) 85%, var(--amber)))",
              borderColor: "color-mix(in oklab, var(--amber) 35%, transparent)",
              padding: "40px 44px", position: "relative", overflow: "hidden",
            }}>
              {/* Soft tea-stain in corner */}
              <div aria-hidden style={{
                position: "absolute", top: -60, right: -60, width: 260, height: 260, borderRadius: "50%",
                background: `radial-gradient(circle, ${CONF_COLOR[answer.confidence]}2a 0%, transparent 60%)`,
                pointerEvents: "none",
              }} />

              {/* Meta row */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, gap: 12, flexWrap: "wrap", position: "relative" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                  <span className="ornament" style={{
                    fontSize: "0.72rem", fontFamily: "'Fraunces',Georgia,serif",
                    fontStyle: "italic", fontWeight: 420,
                    color: "var(--amber)", letterSpacing: "0.06em",
                  }}>Recall remembers</span>
                  <span style={{
                    fontSize: "0.78rem", padding: "3px 12px", borderRadius: 999,
                    background: `${CONF_COLOR[answer.confidence]}1f`,
                    border: `1px solid ${CONF_COLOR[answer.confidence]}55`,
                    color: CONF_COLOR[answer.confidence],
                    fontFamily: "'Manrope',sans-serif", fontWeight: 500,
                  }}>
                    {CONF_LABEL[answer.confidence]}
                  </span>
                </div>
                <button onClick={() => speak(answer.answer)} style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "9px 18px", borderRadius: 999,
                  background: "var(--surface-1)", border: "1px solid var(--border-strong)",
                  color: "var(--ink-soft)", fontSize: "0.88rem", cursor: "pointer",
                  fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic",
                  transition: "all 0.2s",
                }}
                  onMouseEnter={e => { e.currentTarget.style.color = "var(--ink)"; e.currentTarget.style.borderColor = "var(--amber)"; e.currentTarget.style.background = "color-mix(in oklab, var(--surface-1) 85%, var(--amber))"; }}
                  onMouseLeave={e => { e.currentTarget.style.color = "var(--ink-soft)"; e.currentTarget.style.borderColor = "var(--border-strong)"; e.currentTarget.style.background = "var(--surface-1)"; }}>
                  <Volume2 size={14} /> read aloud
                </button>
              </div>

              {/* Answer text + thumbnail */}
              <div style={{ display: "flex", gap: 28, alignItems: "flex-start", position: "relative" }}>
                <p style={{
                  flex: 1, fontFamily: "'Fraunces',Georgia,serif",
                  fontSize: "clamp(1.4rem, 2.4vw, 1.85rem)",
                  fontWeight: 400, lineHeight: 1.35,
                  fontVariationSettings: '"opsz" 144, "SOFT" 100',
                  color: "var(--ink)", minHeight: "2.4em",
                  letterSpacing: "-0.01em",
                }}>
                  <span aria-hidden style={{ color: "var(--amber)", opacity: 0.6, fontSize: "1.4em", verticalAlign: "-0.2em", marginRight: "0.15em", fontFamily: "'Fraunces',Georgia,serif" }}>&ldquo;</span>
                  {typedAnswer}
                  {!typingDone && (
                    <span className="animate-cursor" style={{
                      display: "inline-block", width: 2, height: "1.3em",
                      background: "var(--amber)", borderRadius: 2,
                      marginLeft: 3, verticalAlign: "middle",
                    }} />
                  )}
                  {typingDone && <span aria-hidden style={{ color: "var(--amber)", opacity: 0.6, fontSize: "1.4em", verticalAlign: "-0.3em", marginLeft: "0.1em", fontFamily: "'Fraunces',Georgia,serif" }}>&rdquo;</span>}
                </p>

                {thumbSrc && (
                  <div style={{
                    flexShrink: 0, width: 120, height: 86, borderRadius: 14, overflow: "hidden",
                    border: "1px solid var(--border-em)", boxShadow: "0 0 28px rgba(124,141,101,0.12)",
                    position: "relative",
                  }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={thumbSrc} alt="Location" style={{ width: "100%", height: "100%", objectFit: "cover", filter: "blur(1.5px) brightness(0.7)" }}
                      onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                    <div style={{
                      position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
                      width: 24, height: 24, borderRadius: "50%", border: "2px solid #C66548",
                      boxShadow: "0 0 16px rgba(248,113,113,0.8)",
                    }} />
                    <div style={{ position: "absolute", bottom: 4, left: 0, right: 0, textAlign: "center", fontSize: "0.6rem", color: "rgba(255,255,255,0.5)", fontFamily: "'Manrope',sans-serif" }}>
                      last seen here
                    </div>
                  </div>
                )}
              </div>

              <div style={{
                marginTop: 24, paddingTop: 18, borderTop: "1px dashed var(--border)",
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", position: "relative",
              }}>
                {answer.event_ids?.length > 0 ? (
                  <p style={{
                    margin: 0, fontSize: "0.82rem", color: "var(--ink-mute)",
                    fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic",
                  }}>
                    drawn from {answer.event_ids.length} {answer.event_ids.length === 1 ? "moment" : "moments"} in today's log
                  </p>
                ) : <span />}
                {answer._model && (
                  <span style={{
                    fontSize: "0.74rem", color: "var(--ink-mute)",
                    fontFamily: "'Manrope',sans-serif", opacity: 0.75,
                  }}>
                    answered by {answer._model.replace("MBZUAI-IFM/", "").replace("claude-opus-4-7", "Claude Opus 4.7")}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* ── JOURNAL (full width — moved up from the old grid slot) ─── */}
          <div className="card" style={{
            padding: "32px 36px", display: "flex", flexDirection: "column",
          }}>
            {/* Header — editorial */}
            <div style={{ marginBottom: 24 }}>
              <div style={{
                fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic",
                fontSize: "0.78rem", color: "var(--amber)", letterSpacing: "0.08em",
                textTransform: "uppercase", marginBottom: 6,
              }}>Today</div>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <h2 style={{
                  fontFamily: "'Fraunces',Georgia,serif", fontSize: "1.7rem",
                  fontWeight: 420, margin: 0, lineHeight: 1.1, letterSpacing: "-0.015em",
                  fontVariationSettings: '"opsz" 144, "SOFT" 100',
                }}>
                  What your home noticed
                </h2>
                <span style={{
                  fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic",
                  fontSize: "0.95rem", color: "var(--ink-mute)", flexShrink: 0,
                }}>
                  {events.length} {events.length === 1 ? "moment" : "moments"}
                </span>
              </div>
            </div>

            {/* List — journal entries, 2-3 per row depending on viewport */}
            <div style={{
              flex: 1, overflowY: "auto", maxHeight: 720,
              marginRight: -8, paddingRight: 8,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
              gap: "4px 28px",
              alignContent: "start",
            }}>
                {events.map((e, idx) => {
                  const isNew = newEventId === e.id;
                  const isMed = isMedEvent(e);
                  const isPerson = isPersonEvent(e);
                  const accent = isMed ? "var(--emerald)" : isPerson ? "var(--indigo)" : "var(--amber)";
                  const accentRgb = isMed ? "124,141,101" : isPerson ? "154,111,94" : "184,116,63";
                  const label = isMed
                    ? "medication"
                    : (e.event_type === "action_detected" && ACTION_LABEL[e.object])
                    || EVENT_LABEL[e.event_type]
                    || e.event_type.replace(/_/g, " ");
                  const displayObject = e.event_type === "action_detected"
                    ? (ACTION_LABEL[e.object] ?? e.object)
                    : e.object;
                  return (
                    <div key={e.id} style={{
                      padding: "14px 4px 14px 16px",
                      borderLeft: `2px solid ${isNew ? accent : `rgba(${accentRgb},0.22)`}`,
                      marginLeft: 4,
                      background: isNew ? `rgba(${accentRgb},0.07)` : "transparent",
                      borderRadius: isNew ? 8 : 4,
                      transition: "background 0.5s, border-color 0.5s",
                      animation: isNew ? "eventIn 0.4s cubic-bezier(0.16,1,0.3,1) forwards" : undefined,
                      position: "relative",
                      minWidth: 0,
                    }}>
                      {/* Verb label — lowercase, gentle */}
                      <div style={{
                        fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic", fontWeight: 420,
                        fontSize: "0.78rem", color: accent, marginBottom: 4,
                        letterSpacing: "0.01em",
                      }}>
                        {label}
                      </div>

                      {/* Object as the lead */}
                      <div style={{
                        fontFamily: "'Fraunces',Georgia,serif",
                        fontSize: "1.05rem", fontWeight: 400,
                        fontVariationSettings: '"opsz" 72, "SOFT" 100',
                        color: "var(--ink)", lineHeight: 1.3,
                        letterSpacing: "-0.005em",
                        overflow: "hidden", textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}>
                        {displayObject}
                        {e.location && <span style={{ color: "var(--ink-soft)", fontWeight: 380 }}> on {e.location}</span>}
                        {e.room && <span style={{ color: "var(--ink-mute)", fontWeight: 380 }}> · {e.room}</span>}
                      </div>

                      {/* Time in soft italic */}
                      <div style={{
                        fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic",
                        fontSize: "0.85rem", color: "var(--ink-mute)", marginTop: 6,
                      }}>
                        {fmtRelative(e.ts)} · {fmtTime(e.ts)}
                      </div>
                    </div>
                  );
                })}

                {events.length === 0 && (
                  <div style={{ padding: "56px 16px", textAlign: "center" }}>
                    <p style={{
                      fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic",
                      fontSize: "1.05rem", color: "var(--ink-soft)", margin: 0,
                    }}>
                      The house is still quiet.
                    </p>
                    <p style={{
                      marginTop: 6, fontSize: "0.88rem", color: "var(--ink-mute)",
                      fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic",
                    }}>
                      Place something in view of the camera to begin.
                    </p>
                  </div>
                )}
              </div>
            </div>

          {/* ── STATS + ALERTS GRID (stats stacked left, nudges wide right) ── */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 22 }}>

            {/* ─ Stats column — cards stacked vertically ─ */}
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              <StatCard
                label="Moments noticed today" value={totalEvents}
                sub={`${events.filter(e => e.ts > Date.now() / 1000 - 3600).length} in the last hour`}
                icon={Activity} accent="var(--amber)" glow="rgba(184,116,63,0.18)"
              />
              <StatCard
                label="Medication" value={medDoses}
                sub={medDoses > 0 ? (medDoses === 1 ? "once today · on time" : `${medDoses} times today`) : "not seen yet today"}
                icon={Zap} accent="var(--emerald)" glow="rgba(124,141,101,0.22)"
                active={medDoses > 0}
              />
              <StatCard
                label="Someone was home"
                value={lastPersonEv ? fmtRelative(lastPersonEv.ts) : "—"}
                sub={lastPersonEv ? (lastPersonEv.event_type.includes("left") ? "just stepped away" : "stepped in") : "the house is quiet"}
                icon={Users} accent="var(--indigo)" glow="rgba(154,111,94,0.15)"
                active={!!lastPersonEv}
              />
            </div>

            {/* ─ Gentle nudges ─ */}
            <div className="card" style={{ padding: "30px 32px" }}>
              {/* Header */}
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24, gap: 16 }}>
                <div>
                  <div style={{
                    fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic",
                    fontSize: "0.78rem", color: "var(--amber)", letterSpacing: "0.08em",
                    textTransform: "uppercase", marginBottom: 6,
                  }}>Looking after you</div>
                  <h2 style={{
                    fontFamily: "'Fraunces',Georgia,serif", fontSize: "1.55rem",
                    fontWeight: 420, margin: 0, lineHeight: 1.1, letterSpacing: "-0.015em",
                    fontVariationSettings: '"opsz" 144, "SOFT" 100',
                  }}>
                    Gentle nudges
                  </h2>
                  <p style={{
                    fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic",
                    fontSize: "0.92rem", color: "var(--ink-soft)", marginTop: 8, lineHeight: 1.45, maxWidth: 420,
                  }}>
                    Recall quietly checks a few things — medication, the front door, anything that wandered — and says something only when it matters.
                  </p>
                </div>
                <button onClick={checkAgent} style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "12px 22px", borderRadius: 999, flexShrink: 0,
                  background: agentChecked && alerts.length === 0 ? "color-mix(in oklab, var(--surface-1) 82%, var(--emerald))" : "var(--surface-2)",
                  border: `1px solid ${agentChecked && alerts.length === 0 ? "var(--border-em)" : "var(--border-strong)"}`,
                  color: agentChecked && alerts.length === 0 ? "var(--emerald)" : "var(--ink)",
                  fontFamily: "'Fraunces',Georgia,serif", fontSize: "0.95rem", fontWeight: 400,
                  fontStyle: agentChecked && alerts.length === 0 ? "normal" : "italic",
                  cursor: "pointer",
                  transition: "all 0.22s",
                }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--amber)"; e.currentTarget.style.transform = "translateY(-1px)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = agentChecked && alerts.length === 0 ? "var(--border-em)" : "var(--border-strong)"; e.currentTarget.style.transform = "none"; }}>
                  {agentChecked && alerts.length === 0 ? <><CheckCircle2 size={15} /> All is well</> : "Check on things"}
                </button>
              </div>

              {/* Alerts */}
              {alerts.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {alerts.map((a, i) => {
                    const urgent = a.severity === "urgent";
                    const ac = urgent ? "#C66548" : "#B8743F";
                    return (
                      <div key={i} className={`animate-slide-up ${urgent ? "card-urgent" : "card-warn"}`}
                        style={{ padding: 20, animationDelay: `${i * 60}ms` }}>
                        <div style={{ display: "flex", gap: 14, marginBottom: a.suggested_action?.draft ? 16 : 0 }}>
                          <div style={{
                            width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            background: `${ac}20`,
                          }}>
                            <AlertTriangle size={15} color={ac} />
                          </div>
                          <div>
                            <div style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: "0.95rem", fontWeight: 700, color: ac, marginBottom: 6 }}>
                              {a.title}
                            </div>
                            <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", lineHeight: 1.7 }}>
                              {a.body}
                            </div>
                          </div>
                        </div>

                        {a.suggested_action?.draft && (
                          <div style={{
                            marginTop: 16, borderRadius: 12, padding: 16,
                            background: "rgba(0,0,0,0.25)", border: "1px solid var(--border)",
                          }}>
                            <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontFamily: "'Manrope',sans-serif", marginBottom: 8 }}>
                              Draft message to {a.suggested_action.to_name}
                            </div>
                            <p style={{ fontSize: "0.88rem", color: "var(--text-secondary)", lineHeight: 1.75, fontStyle: "italic", marginBottom: 14 }}>
                              "{a.suggested_action.draft}"
                            </p>
                            <button onClick={async () => { try { await fetch(`${API_BASE}/agent/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: a.suggested_action }) }); } catch { } }} style={{
                              display: "flex", alignItems: "center", gap: 8,
                              padding: "9px 18px", borderRadius: 10, cursor: "pointer",
                              background: `${ac}1a`, border: `1px solid ${ac}44`, color: ac,
                              fontFamily: "'Fraunces',Georgia,serif", fontSize: "0.85rem", fontWeight: 600,
                              transition: "all 0.15s",
                            }}
                              onMouseEnter={e => { e.currentTarget.style.filter = "brightness(1.15)"; e.currentTarget.style.transform = "translateY(-1px)"; }}
                              onMouseLeave={e => { e.currentTarget.style.filter = "none"; e.currentTarget.style.transform = "none"; }}>
                              <Send size={13} /> Send to {a.suggested_action.to_name}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "52px 20px", textAlign: "center" }}>
                  {agentChecked ? (
                    <>
                      <div className="animate-pulse-em" style={{
                        width: 68, height: 68, borderRadius: "50%",
                        display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 18,
                        background: "color-mix(in oklab, var(--surface-1) 80%, var(--emerald))",
                        border: "1px solid var(--border-em)",
                      }}>
                        <CheckCircle2 size={28} color="var(--emerald)" />
                      </div>
                      <p style={{
                        fontFamily: "'Fraunces',Georgia,serif", fontSize: "1.35rem",
                        fontWeight: 420, margin: 0, color: "var(--ink)",
                        fontVariationSettings: '"opsz" 144, "SOFT" 100',
                      }}>All is well.</p>
                      <p style={{
                        marginTop: 8, fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic",
                        fontSize: "0.95rem", color: "var(--ink-soft)", maxWidth: 320,
                      }}>
                        Nothing needs your attention right now.
                      </p>
                    </>
                  ) : (
                    <>
                      <div style={{
                        width: 68, height: 68, borderRadius: "50%",
                        display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 18,
                        background: "var(--surface-2)", border: "1px solid var(--border-strong)",
                      }}>
                        <AlertTriangle size={26} color="var(--ink-mute)" />
                      </div>
                      <p style={{
                        fontFamily: "'Fraunces',Georgia,serif", fontSize: "1.25rem",
                        fontWeight: 420, margin: 0, color: "var(--ink)",
                        fontVariationSettings: '"opsz" 144, "SOFT" 100',
                      }}>Everything's calm so far.</p>
                      <p style={{
                        marginTop: 8, fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic",
                        fontSize: "0.95rem", color: "var(--ink-soft)", maxWidth: 360, lineHeight: 1.55,
                      }}>
                        Tap <em style={{ color: "var(--amber)" }}>Check on things</em> and Recall will quietly
                        look over medication, the front door, and anything left around.
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>

          </div>

          {/* ── FLOOR PLAN ────────────────────────────────────────────────── */}
          <div className="card" style={{ padding: "30px 32px" }}>
            <HomeLayout events={events} />
          </div>

        </div>

        {/* ── FOOTER ───────────────────────────────────────────────────────── */}
        <footer style={{
          maxWidth: 1180, margin: "0 auto", padding: "32px 28px 48px",
          borderTop: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, flexWrap: "wrap",
        }}>
          <span style={{
            fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic",
            fontSize: "0.95rem", color: "var(--ink-soft)",
          }}>
            Recall — made at HackPrinceton 2026.
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{
              width: 8, height: 8, borderRadius: "50%",
              background: "var(--emerald)", display: "inline-block",
              boxShadow: "0 0 0 3px rgba(124,141,101,0.18)",
            }} />
            <span style={{
              fontFamily: "'Fraunces',Georgia,serif", fontStyle: "italic",
              fontSize: "0.95rem", color: "var(--ink-soft)",
            }}>
              no video ever leaves this device — only what it noticed.
            </span>
          </div>
        </footer>

      </div>
    </main>
  );
}
