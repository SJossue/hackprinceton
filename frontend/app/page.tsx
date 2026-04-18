"use client";

/**
 * Rewind — Command Center
 * "Your home has a memory. Just ask."
 *
 * Owner: Jeeyan (frontend) — HackPrinceton 2026
 *
 * Backend contract (PROJECT.md):
 *   GET  /events?limit=N        → EventRow[]
 *   WS   /ws/events             → streams EventRow JSON
 *   POST /query  {question}     → {answer, confidence, event_ids, _model?}
 *   POST /agent/check           → Alert[]
 *   POST /agent/action {action} → 200 OK
 *   GET  /thumb/<thumb_path>    → 128×72 blurred JPEG
 *
 * Audio: STT + TTS via Web Speech API (Chrome/Edge). Typed input = primary fallback.
 * Mock:  if Pi unreachable → mock events + mock answers for all hero queries.
 * WS:    auto-reconnects with exponential backoff for venue WiFi drops.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle, CheckCircle2, Clock, Eye, EyeOff,
  MapPin, Mic, MicOff, Send, Volume2, Wifi, WifiOff,
} from "lucide-react";

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const API_BASE = (process.env.NEXT_PUBLIC_REWIND_API ?? "http://localhost:8000").replace(/\/$/, "");
const WS_URL   = API_BASE.replace(/^http/, "ws") + "/ws/events";

// ─────────────────────────────────────────────
// Types — exact mirror of backend contract
// ─────────────────────────────────────────────

type EventRow = {
  id:          number;
  ts:          number;
  event_type:  string;
  object:      string;
  track_id?:   number | null;
  confidence?: number | null;
  thumb_path?: string | null;
  location_x?: number | null;
  location_y?: number | null;
};

type Answer = {
  answer:     string;
  confidence: "high" | "medium" | "low";
  event_ids:  number[];
  _model?:    string;
};

type Alert = {
  severity: "info" | "warn" | "urgent";
  title:    string;
  body:     string;
  suggested_action?: {
    type:     string;
    to_name?: string;
    draft?:   string;
  } | null;
};

// ─────────────────────────────────────────────
// Mock data
// ─────────────────────────────────────────────

const MOCK_OBJECTS = [
  "keys", "phone", "pill bottle", "wallet", "water bottle",
  "TV remote", "glasses", "notebook", "charger", "book",
];
const MOCK_ETYPES = [
  "object_placed", "object_removed", "person_entered_frame",
  "person_left_frame", "object_picked_up", "medication_taken",
];
let _mockId = 1000;

function makeMockEvent(): EventRow {
  return {
    id:         _mockId++,
    ts:         Math.floor(Date.now() / 1000),
    event_type: MOCK_ETYPES[Math.floor(Math.random() * MOCK_ETYPES.length)],
    object:     MOCK_OBJECTS[Math.floor(Math.random() * MOCK_OBJECTS.length)],
    location_x: Math.random(),
    location_y: Math.random(),
    thumb_path: null,
  };
}

const SEED_EVENTS: EventRow[] = Array.from({ length: 24 }, (_, i) => ({
  id:         i + 1,
  ts:         Math.floor(Date.now() / 1000) - (24 - i) * 210 - Math.floor(Math.random() * 90),
  event_type: MOCK_ETYPES[i % MOCK_ETYPES.length],
  object:     MOCK_OBJECTS[i % MOCK_OBJECTS.length],
  location_x: Math.random(),
  location_y: Math.random(),
  thumb_path: null,
}));

const MOCK_ANSWERS: [string, string][] = [
  ["keys",       "Your keys were placed on the counter near the sink at 3:14 PM — about 47 minutes ago."],
  ["medication", "Yes. The pill bottle was picked up at 8:02 AM. You opened it and drank water. First time since yesterday morning."],
  ["pill",       "Yes. The pill bottle was picked up at 8:02 AM. You opened it and drank water. First time since yesterday morning."],
  ["meds",       "Yes. The pill bottle was picked up at 8:02 AM. You opened it and drank water. First time since yesterday morning."],
  ["someone",    "A person entered the frame at 2:47 PM — approximately 64 minutes ago."],
  ["phone",      "Your phone was last seen on the left side of the desk at 4:11 PM, about 22 minutes ago."],
  ["wallet",     "Your wallet was placed on the kitchen counter at 1:32 PM — about 2 hours ago."],
  ["object",     "The object was placed on the right edge of the table, 52 seconds ago."],
];

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function fmtRelative(ts: number): string {
  const d = Math.floor(Date.now() / 1000) - ts;
  if (d < 60)   return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  return `${Math.floor(d / 3600)}h ago`;
}

function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u      = new SpeechSynthesisUtterance(text);
  u.rate       = 1.0; u.pitch = 1.0;
  const voices = window.speechSynthesis.getVoices();
  const pref   = voices.find(v => /Samantha|Jenny|Google US English|Microsoft Aria/i.test(v.name));
  if (pref) u.voice = pref;
  window.speechSynthesis.speak(u);
}

type SRClass = new () => {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: (e: any) => void; onend: () => void; onerror: (e: any) => void;
  start: () => void; stop: () => void;
};
function getSR(): SRClass | null {
  if (typeof window === "undefined") return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

function thumbURL(p: string) { return `${API_BASE}/thumb/${p}`; }

const CONF_COLOR: Record<string, string> = {
  high: "#34d399", medium: "#fbbf24", low: "#f87171",
};
const CONF_LABEL: Record<string, string> = {
  high: "High confidence", medium: "Medium confidence", low: "Low confidence",
};

const EVENT_GLYPH: Record<string, string> = {
  object_placed:        "↓",
  object_removed:       "↑",
  object_picked_up:     "↑",
  object_moved:         "→",
  person_entered_frame: "▶",
  person_left_frame:    "◀",
  medication_taken:     "+",
  action_detected:      "◉",
};

const EVENT_LABEL: Record<string, string> = {
  object_placed:        "placed",
  object_removed:       "removed",
  object_picked_up:     "picked up",
  object_moved:         "moved",
  person_entered_frame: "person entered",
  person_left_frame:    "person left",
  medication_taken:     "medication taken",
  action_detected:      "action detected",
};

// Demo hero queries — medication first per DEMO_SCRIPT.md
const PRESET_QUERIES = [
  { label: "Did I take my medication today?",  icon: "💊", hero: true  },
  { label: "Where did I leave my keys?",       icon: "🔑", hero: false },
  { label: "When did someone last come in?",   icon: "🚶", hero: false },
  { label: "Where is my phone?",               icon: "📱", hero: false },
];

// ─────────────────────────────────────────────
// Live indicator dot
// ─────────────────────────────────────────────

function LiveDot({ active }: { active: boolean }) {
  return (
    <span className="relative inline-flex w-2 h-2 shrink-0">
      <span className="absolute inset-0 rounded-full"
        style={{ background: active ? "var(--emerald)" : "var(--text-muted)" }} />
      {active && (
        <span className="absolute inset-0 rounded-full animate-ping opacity-60"
          style={{ background: "var(--emerald)" }} />
      )}
    </span>
  );
}

// ─────────────────────────────────────────────
// Heatmap canvas
// ─────────────────────────────────────────────

function Heatmap({ events }: { events: EventRow[] }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;

    ctx.clearRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth   = 1;
    for (let x = 0; x <= W; x += W / 6) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y <= H; y += H / 4) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    const located = events.filter(e => e.location_x != null && e.location_y != null);

    located.forEach((e, idx) => {
      const x   = (e.location_x ?? 0.5) * W;
      const y   = (e.location_y ?? 0.5) * H;
      const med = e.event_type === "medication_taken";
      const age = Math.max(0, 1 - idx / 40);
      const r   = med ? 44 : 30;
      const g   = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, med
        ? `rgba(16,185,129,${0.6 * age})`
        : `rgba(99,102,241,${0.35 * age})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    });

    located.slice(0, 8).forEach((e, idx) => {
      const x   = (e.location_x ?? 0.5) * W;
      const y   = (e.location_y ?? 0.5) * H;
      const med = e.event_type === "medication_taken";
      const a   = 1 - idx * 0.1;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = med ? `rgba(16,185,129,${a})` : `rgba(148,163,184,${a})`;
      ctx.fill();
      if (idx < 5) {
        ctx.font      = "9px 'JetBrains Mono', monospace";
        ctx.fillStyle = `rgba(255,255,255,${a * 0.55})`;
        ctx.fillText(e.object.slice(0, 14), x + 8, y + 4);
      }
    });
  }, [events]);

  const medCount = events.filter(e => e.event_type === "medication_taken").length;

  return (
    <div>
      {/* Explainer for judges */}
      <p className="text-xs mb-3" style={{ color: "var(--text-secondary)", lineHeight: 1.6 }}>
        Each dot marks where an event happened in the room — based on the object's position
        in the camera frame. <span style={{ color: "var(--emerald)" }}>Green = medication events.</span>{" "}
        No video is ever stored — only these coordinates.
      </p>

      <div className="rounded-xl overflow-hidden relative"
        style={{ border: "1px solid var(--border)", background: "var(--surface-2)" }}>
        <canvas ref={ref} width={900} height={200} className="w-full" style={{ display: "block" }} />

        <div className="absolute bottom-3 right-4 flex items-center gap-4 text-xs"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: "#10b981", display: "inline-block" }} />
            <span style={{ color: "var(--text-muted)" }}>medication</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: "#6366f1", display: "inline-block" }} />
            <span style={{ color: "var(--text-muted)" }}>other</span>
          </div>
        </div>

        {/* Medication dose count badge */}
        {medCount > 0 && (
          <div className="absolute top-3 left-4 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs"
            style={{
              background: "rgba(16,185,129,0.15)",
              border:     "1px solid rgba(16,185,129,0.3)",
              color:      "var(--emerald)",
              fontFamily: "'JetBrains Mono', monospace",
            }}>
            <CheckCircle2 size={10} />
            {medCount} dose{medCount !== 1 ? "s" : ""} recorded today
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Root page
// ─────────────────────────────────────────────

export default function Page() {
  const [events,        setEvents]        = useState<EventRow[]>(SEED_EVENTS);
  const [question,      setQuestion]      = useState("");
  const [answer,        setAnswer]        = useState<Answer | null>(null);
  const [alerts,        setAlerts]        = useState<Alert[]>([]);
  const [loading,       setLoading]       = useState(false);
  const [listening,     setListening]     = useState(false);
  const [shutterClosed, setShutterClosed] = useState(false);
  const [newEventId,    setNewEventId]    = useState<number | null>(null);
  const [connected,     setConnected]     = useState(false);
  const [agentChecked,  setAgentChecked]  = useState(false);

  const recognitionRef = useRef<any>(null);
  const wsRef          = useRef<WebSocket | null>(null);
  const mockRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectDelay = useRef(1000);
  const eventsRef      = useRef<EventRow[]>(SEED_EVENTS);
  const inputRef       = useRef<HTMLInputElement>(null);

  useEffect(() => { eventsRef.current = events; }, [events]);

  const pushEvent = useCallback((ev: EventRow) => {
    setEvents(prev => {
      const next = [ev, ...prev].slice(0, 100);
      eventsRef.current = next;
      return next;
    });
    setNewEventId(ev.id);
    setTimeout(() => setNewEventId(null), 1500);
  }, []);

  const startMock = useCallback(() => {
    if (mockRef.current) return;
    mockRef.current = setInterval(() => pushEvent(makeMockEvent()), 3000);
  }, [pushEvent]);

  const connectWS = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      reconnectDelay.current = 1000;
      if (mockRef.current) { clearInterval(mockRef.current); mockRef.current = null; }
    };
    ws.onmessage = msg => {
      if (typeof msg.data === "string" && msg.data.trim() === "pong") return;
      try {
        const ev: EventRow = JSON.parse(msg.data);
        if (typeof ev.id === "number" && typeof ev.ts === "number") pushEvent(ev);
      } catch {}
    };
    ws.onerror = () => { setConnected(false); startMock(); };
    ws.onclose = () => {
      setConnected(false);
      const delay = Math.min(reconnectDelay.current, 30_000);
      reconnectDelay.current = delay * 2;
      setTimeout(connectWS, delay);
    };
  }, [pushEvent, startMock]);

  useEffect(() => {
    fetch(`${API_BASE}/events?limit=80`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then((data: EventRow[]) => {
        if (Array.isArray(data) && data.length > 0) {
          setEvents(data); eventsRef.current = data;
        }
        setConnected(true);
      })
      .catch(() => startMock());

    connectWS();

    const ping = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send("ping");
    }, 15_000);

    return () => {
      clearInterval(ping);
      wsRef.current?.close();
      if (mockRef.current) clearInterval(mockRef.current);
    };
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
    try {
      const r = await fetch(`${API_BASE}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: query }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data: Answer = await r.json();
      setAnswer(data);
      speak(data.answer);
    } catch {
      const lower   = query.toLowerCase();
      const matched = MOCK_ANSWERS.find(([k]) => lower.includes(k));
      const ans     = matched?.[1] ?? "I didn't see that happen in recent events. Try rephrasing, or check the device is watching.";
      setAnswer({ answer: ans, confidence: matched ? "high" : "low", event_ids: matched ? [42, 43] : [], _model: "mock" });
      speak(ans);
    } finally {
      setLoading(false);
    }
  }, [question]);

  function toggleListen() {
    const SR = getSR();
    if (!SR) { alert("Voice input works in Chrome and Edge. You can also type your question."); return; }
    if (listening && recognitionRef.current) { recognitionRef.current.stop(); return; }
    const recog = new SR();
    recog.continuous = false; recog.interimResults = false; recog.lang = "en-US";
    recog.onresult = (e: any) => { const t = e.results[0][0].transcript; setQuestion(t); setTimeout(() => ask(t), 100); };
    recog.onend    = () => setListening(false);
    recog.onerror  = () => setListening(false);
    recognitionRef.current = recog;
    setListening(true); recog.start();
  }

  async function checkAgent() {
    setAgentChecked(true);
    try {
      const r = await fetch(`${API_BASE}/agent/check`, { method: "POST" });
      if (!r.ok) throw new Error();
      setAlerts(await r.json());
    } catch {
      setAlerts([{
        severity: "urgent",
        title:    "Evening dose is 6 hours overdue",
        body:     "The pill bottle hasn't been touched since 8:02 AM. Evening dose is usually taken by 9 PM.",
        suggested_action: {
          type:    "sms",
          to_name: "Mom",
          draft:   "Hey Mom, just checking — did you take your evening medication? Rewind noticed the bottle hasn't been opened since this morning.",
        },
      }]);
    }
  }

  function resolveThumb(ans: Answer): string | null {
    if (!ans.event_ids?.length) return null;
    const ev = eventsRef.current.find(e => ans.event_ids.includes(e.id));
    return ev?.thumb_path ? thumbURL(ev.thumb_path) : null;
  }

  const thumbSrc = answer ? resolveThumb(answer) : null;

  // ─────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────

  return (
    <main className="min-h-screen animate-fade-in"
      style={{ background: "var(--bg)", color: "var(--text-primary)" }}>

      {/* ─────────────── HEADER ─────────────── */}
      <header style={{
        borderBottom: "1px solid var(--border)",
        background:   "rgba(10,10,12,0.8)",
        backdropFilter: "blur(12px)",
        position:     "sticky",
        top: 0,
        zIndex: 50,
      }}>
        <div className="max-w-6xl mx-auto px-5 py-3 flex items-center justify-between">
          {/* Brand */}
          <div className="flex items-center gap-3">
            <LiveDot active={!shutterClosed} />
            <span className="font-display text-base font-bold tracking-tight"
              style={{ fontFamily: "'Syne', sans-serif" }}>
              Rewind
            </span>
            <span className="hidden sm:inline text-xs px-2 py-0.5 rounded-full"
              style={{
                background: "var(--surface-2)",
                border:     "1px solid var(--border)",
                color:      "var(--text-muted)",
                fontFamily: "'JetBrains Mono', monospace",
              }}>
              {connected ? "live" : "demo mode"}
            </span>
          </div>

          {/* Right side */}
          <div className="flex items-center gap-2">
            {/* Connection status */}
            <div className="hidden sm:flex items-center gap-1.5 text-xs"
              style={{ color: connected ? "var(--emerald)" : "var(--text-muted)" }}>
              {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
              <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                {connected ? "Pi connected" : "no Pi"}
              </span>
            </div>

            {/* Shutter toggle */}
            <button
              onClick={() => setShutterClosed(s => !s)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all duration-200"
              style={{
                background: shutterClosed ? "rgba(239,68,68,0.1)" : "var(--surface-2)",
                border:     `1px solid ${shutterClosed ? "rgba(239,68,68,0.3)" : "var(--border)"}`,
                color:      shutterClosed ? "#f87171" : "var(--text-secondary)",
              }}>
              {shutterClosed ? <EyeOff size={12} /> : <Eye size={12} />}
              <span className="hidden sm:inline">
                {shutterClosed ? "Shutter closed" : "Watching"}
              </span>
            </button>
          </div>
        </div>
      </header>

      {/* ─────────────── BODY ─────────────── */}
      <div className="max-w-6xl mx-auto px-4 md:px-6 py-6 md:py-8 space-y-6">

        {/* ─── HERO QUERY SECTION ─── */}
        <section className="panel p-6 md:p-8"
          style={{ background: "var(--surface-1)" }}>

          {/* Section heading */}
          <div className="flex items-center gap-2 mb-6">
            <span className="tag">Ask a question</span>
          </div>

          {/* Large input */}
          <div className="flex gap-3 mb-5">
            <div className="flex-1 relative">
              <input
                ref={inputRef}
                value={question}
                onChange={e => setQuestion(e.target.value)}
                onKeyDown={e => e.key === "Enter" && !loading && ask()}
                placeholder="What do you want to know?"
                className="w-full outline-none transition-all duration-200"
                style={{
                  background:   "var(--surface-2)",
                  border:       "1px solid var(--border-strong)",
                  borderRadius: "12px",
                  padding:      "16px 20px",
                  fontSize:     "1rem",
                  color:        "var(--text-primary)",
                  caretColor:   "var(--emerald)",
                  fontFamily:   "'Syne', sans-serif",
                }}
                onFocus={e => {
                  e.currentTarget.style.borderColor = "var(--border-em)";
                  e.currentTarget.style.boxShadow   = "0 0 0 4px rgba(16,185,129,0.08)";
                }}
                onBlur={e => {
                  e.currentTarget.style.borderColor = "var(--border-strong)";
                  e.currentTarget.style.boxShadow   = "none";
                }}
              />
              {/* Hint inside input */}
              {!question && (
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs pointer-events-none"
                  style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>
                  or tap a question below ↓
                </span>
              )}
            </div>

            {/* Ask button */}
            <button
              onClick={() => ask()}
              disabled={loading || !question.trim()}
              className="flex items-center gap-2 px-6 rounded-xl font-semibold transition-all duration-150 shrink-0 disabled:opacity-40"
              style={{
                background: "var(--emerald)",
                color:      "#000",
                fontSize:   "0.875rem",
                fontFamily: "'Syne', sans-serif",
                minWidth:   "5rem",
              }}
              onMouseEnter={e => { if (!loading) e.currentTarget.style.filter = "brightness(1.1)"; }}
              onMouseLeave={e => { e.currentTarget.style.filter = "none"; }}>
              {loading
                ? <span className="animate-blink" style={{ letterSpacing: "0.2em" }}>···</span>
                : <><Send size={15} /> Ask</>
              }
            </button>

            {/* Voice button */}
            <button
              onClick={toggleListen}
              title={listening ? "Tap to stop" : "Tap to speak (Chrome/Edge)"}
              className="flex items-center justify-center rounded-xl transition-all duration-150 shrink-0"
              style={{
                width:      "52px",
                height:     "52px",
                background: listening ? "rgba(239,68,68,0.15)" : "var(--surface-2)",
                border:     `1px solid ${listening ? "rgba(239,68,68,0.4)" : "var(--border-strong)"}`,
                color:      listening ? "#f87171" : "var(--text-secondary)",
                boxShadow:  listening ? "0 0 0 4px rgba(239,68,68,0.1)" : "none",
              }}>
              {listening ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
          </div>

          {/* Status under input when listening */}
          {listening && (
            <p className="text-xs mb-4 animate-blink"
              style={{ color: "#f87171", fontFamily: "'JetBrains Mono', monospace" }}>
              🎤 Listening… speak your question
            </p>
          )}

          {/* Preset chips — tappable, big enough for fingers */}
          <div>
            <p className="text-xs mb-3" style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>
              Try one of these:
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {PRESET_QUERIES.map(({ label, icon, hero }) => (
                <button
                  key={label}
                  onClick={() => { setQuestion(label); setTimeout(() => ask(label), 50); }}
                  className="flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-all duration-150"
                  style={{
                    background:  hero ? "rgba(16,185,129,0.08)" : "var(--surface-2)",
                    border:      `1px solid ${hero ? "var(--border-em)" : "var(--border)"}`,
                    color:       hero ? "var(--text-primary)" : "var(--text-secondary)",
                    fontSize:    "0.8125rem",
                    fontFamily:  "'Syne', sans-serif",
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.background   = hero ? "rgba(16,185,129,0.12)" : "var(--surface-3)";
                    e.currentTarget.style.borderColor  = "var(--border-em)";
                    e.currentTarget.style.color        = "var(--text-primary)";
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background   = hero ? "rgba(16,185,129,0.08)" : "var(--surface-2)";
                    e.currentTarget.style.borderColor  = hero ? "var(--border-em)" : "var(--border)";
                    e.currentTarget.style.color        = hero ? "var(--text-primary)" : "var(--text-secondary)";
                  }}>
                  <span style={{ fontSize: "1.1rem" }}>{icon}</span>
                  <span>{label}</span>
                  {hero && (
                    <span className="ml-auto text-xs px-2 py-0.5 rounded-full shrink-0"
                      style={{
                        background: "rgba(16,185,129,0.15)",
                        color:      "var(--emerald)",
                        fontFamily: "'JetBrains Mono', monospace",
                      }}>
                      demo
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* ─── ANSWER CARD ─── */}
        {answer && (
          <section className="panel-em p-6 md:p-8 animate-slide-up"
            style={{ position: "relative", overflow: "hidden" }}>
            {/* Top accent bar */}
            <div style={{
              position:   "absolute",
              top: 0, left: 0, right: 0,
              height:     "3px",
              background: `linear-gradient(90deg, transparent 0%, ${CONF_COLOR[answer.confidence]} 40%, transparent 100%)`,
            }} />

            {/* Meta row */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <span className="tag">Rewind says</span>
                <span className="text-xs px-2.5 py-1 rounded-full"
                  style={{
                    background: `${CONF_COLOR[answer.confidence]}18`,
                    border:     `1px solid ${CONF_COLOR[answer.confidence]}40`,
                    color:      CONF_COLOR[answer.confidence],
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize:   "0.7rem",
                  }}>
                  {CONF_LABEL[answer.confidence]}
                </span>
                {answer._model && (
                  <span className="text-xs" style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>
                    via {answer._model}
                  </span>
                )}
              </div>
              {/* Replay TTS */}
              <button
                onClick={() => speak(answer.answer)}
                title="Hear the answer again"
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all duration-150"
                style={{
                  background: "var(--surface-2)",
                  border:     "1px solid var(--border)",
                  color:      "var(--text-secondary)",
                }}>
                <Volume2 size={13} />
                <span className="hidden sm:inline">Replay</span>
              </button>
            </div>

            {/* Answer content */}
            <div className="flex gap-5 items-start">
              <p className="flex-1 leading-relaxed"
                style={{
                  fontFamily: "'Syne', sans-serif",
                  fontSize:   "1.25rem",
                  fontWeight: 500,
                  color:      "var(--text-primary)",
                }}>
                {answer.answer}
              </p>

              {/* 128×72 blurred thumbnail with red location ring */}
              {thumbSrc && (
                <div className="shrink-0 rounded-xl overflow-hidden relative"
                  style={{ width: 112, height: 80, border: "1px solid var(--border-em)", boxShadow: "0 0 20px rgba(16,185,129,0.1)" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={thumbSrc}
                    alt="Where it happened"
                    className="w-full h-full object-cover"
                    style={{ filter: "blur(1.5px) brightness(0.75)" }}
                    onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                  <div style={{
                    position:     "absolute",
                    top: "50%", left: "50%",
                    transform:    "translate(-50%,-50%)",
                    width: 22, height: 22,
                    borderRadius: "50%",
                    border:       "2px solid #f87171",
                    boxShadow:    "0 0 12px rgba(248,113,113,0.7)",
                  }} />
                  <div className="absolute bottom-1 left-0 right-0 text-center text-xs"
                    style={{ color: "rgba(255,255,255,0.5)", fontFamily: "'JetBrains Mono', monospace", fontSize: "0.6rem" }}>
                    last seen here
                  </div>
                </div>
              )}
            </div>

            {answer.event_ids?.length > 0 && (
              <p className="mt-4 text-xs" style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>
                based on events #{answer.event_ids.join(", #")}
              </p>
            )}
          </section>
        )}

        {/* ─── MAIN 2-COL GRID ─── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

          {/* ─── LEFT: Event timeline ─── */}
          <div className="lg:col-span-1 panel p-5 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Clock size={12} style={{ color: "var(--text-muted)" }} />
                <span className="tag">What happened · last 24h</span>
              </div>
              <span className="text-xs tabular-nums"
                style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>
                {events.length} events
              </span>
            </div>

            <ul className="flex-1 overflow-y-auto space-y-0" style={{ maxHeight: "520px" }}>
              {events.map((e, idx) => {
                const isNew = newEventId === e.id;
                const isMed = e.event_type === "medication_taken";
                return (
                  <li key={e.id}
                    className="transition-all duration-500"
                    style={{
                      borderBottom: "1px solid var(--border)",
                      background:   isNew ? "rgba(16,185,129,0.07)" : "transparent",
                      borderRadius: isNew ? "8px" : undefined,
                      opacity:      Math.max(0.2, 1 - idx * 0.024),
                    }}>
                    <div className="flex items-start gap-3 py-3 px-1">
                      {/* Glyph */}
                      <span className="text-xs mt-0.5 w-4 text-center shrink-0"
                        style={{ color: isMed ? "var(--emerald)" : "var(--text-muted)" }}>
                        {EVENT_GLYPH[e.event_type] ?? "·"}
                      </span>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span className="text-sm font-medium truncate"
                            style={{
                              color:      isMed ? "var(--emerald)" : "var(--text-primary)",
                              fontFamily: "'Syne', sans-serif",
                            }}>
                            {e.object}
                          </span>
                          {isMed && (
                            <span className="text-xs shrink-0 px-1.5 py-0.5 rounded"
                              style={{
                                background: "rgba(16,185,129,0.12)",
                                color:      "var(--emerald)",
                                fontFamily: "'JetBrains Mono', monospace",
                                fontSize:   "0.6rem",
                              }}>
                              ✓ meds
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                            {EVENT_LABEL[e.event_type] ?? e.event_type.replace(/_/g, " ")}
                          </span>
                          <span className="text-xs" style={{ color: "var(--text-muted)" }}>·</span>
                          <span className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
                            {fmtRelative(e.ts)}
                          </span>
                        </div>
                      </div>

                      {/* Exact time on hover — always visible on small screens */}
                      <span className="text-xs tabular-nums shrink-0"
                        style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace", fontSize: "0.65rem" }}>
                        {fmtTime(e.ts)}
                      </span>
                    </div>
                  </li>
                );
              })}
              {events.length === 0 && (
                <li className="py-10 text-center">
                  <p className="text-sm" style={{ color: "var(--text-muted)" }}>No events yet.</p>
                  <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Place something in view of the camera.</p>
                </li>
              )}
            </ul>
          </div>

          {/* ─── RIGHT: Proactive agent ─── */}
          <div className="lg:col-span-2 panel p-5">
            <div className="flex items-center justify-between mb-5">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle size={12} style={{ color: "var(--text-muted)" }} />
                  <span className="tag">Proactive alerts</span>
                </div>
                <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
                  Checks your event log against your schedule. Flags anything that needs attention.
                </p>
              </div>
              <button
                onClick={checkAgent}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 shrink-0"
                style={{
                  background:  agentChecked && alerts.length === 0
                    ? "rgba(16,185,129,0.08)"
                    : "var(--surface-2)",
                  border:      `1px solid ${agentChecked && alerts.length === 0 ? "var(--border-em)" : "var(--border-strong)"}`,
                  color:       agentChecked && alerts.length === 0 ? "var(--emerald)" : "var(--text-primary)",
                  fontFamily:  "'Syne', sans-serif",
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--border-em)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = agentChecked && alerts.length === 0 ? "var(--border-em)" : "var(--border-strong)"; }}>
                {agentChecked && alerts.length === 0
                  ? <><CheckCircle2 size={14} /> All clear</>
                  : "Run check"
                }
              </button>
            </div>

            {/* Alert cards */}
            {alerts.length > 0 ? (
              <div className="space-y-4">
                {alerts.map((a, i) => {
                  const urgent = a.severity === "urgent";
                  return (
                    <div key={i} className={urgent ? "panel-alert-urgent" : "panel-alert-warn"}
                      style={{ padding: "20px" }}>
                      {/* Alert header */}
                      <div className="flex items-start gap-3 mb-3">
                        <div className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center mt-0.5"
                          style={{ background: urgent ? "rgba(239,68,68,0.15)" : "rgba(245,158,11,0.15)" }}>
                          <AlertTriangle size={14} style={{ color: urgent ? "#f87171" : "#fbbf24" }} />
                        </div>
                        <div>
                          <div className="text-sm font-semibold mb-1"
                            style={{ fontFamily: "'Syne', sans-serif", color: urgent ? "#fca5a5" : "#fcd34d" }}>
                            {a.title}
                          </div>
                          <div className="text-sm" style={{ color: "var(--text-secondary)", lineHeight: 1.6 }}>
                            {a.body}
                          </div>
                        </div>
                      </div>

                      {/* Draft SMS */}
                      {a.suggested_action?.draft && (
                        <div className="mt-4 rounded-lg p-4"
                          style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border)" }}>
                          <div className="text-xs mb-2" style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>
                            Draft text to {a.suggested_action.to_name}
                          </div>
                          <p className="text-sm mb-3" style={{ color: "var(--text-secondary)", lineHeight: 1.7, fontStyle: "italic" }}>
                            "{a.suggested_action.draft}"
                          </p>
                          <button
                            onClick={async () => {
                              try {
                                await fetch(`${API_BASE}/agent/action`, {
                                  method:  "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body:    JSON.stringify({ action: a.suggested_action }),
                                });
                              } catch {}
                            }}
                            className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-150"
                            style={{
                              background:  urgent ? "rgba(239,68,68,0.15)" : "rgba(245,158,11,0.15)",
                              border:      `1px solid ${urgent ? "rgba(239,68,68,0.35)" : "rgba(245,158,11,0.35)"}`,
                              color:       urgent ? "#fca5a5" : "#fcd34d",
                              fontFamily:  "'Syne', sans-serif",
                            }}
                            onMouseEnter={e => { e.currentTarget.style.filter = "brightness(1.15)"; }}
                            onMouseLeave={e => { e.currentTarget.style.filter = "none"; }}>
                            <Send size={13} />
                            Send to {a.suggested_action.to_name}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                {agentChecked ? (
                  <>
                    <div className="w-12 h-12 rounded-full flex items-center justify-center mb-3"
                      style={{ background: "rgba(16,185,129,0.1)", border: "1px solid var(--border-em)" }}>
                      <CheckCircle2 size={22} style={{ color: "var(--emerald)" }} />
                    </div>
                    <p className="text-sm font-medium mb-1"
                      style={{ fontFamily: "'Syne', sans-serif", color: "var(--text-primary)" }}>
                      All clear
                    </p>
                    <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                      All scheduled items are on track.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="w-12 h-12 rounded-full flex items-center justify-center mb-3"
                      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
                      <AlertTriangle size={20} style={{ color: "var(--text-muted)" }} />
                    </div>
                    <p className="text-sm font-medium mb-1"
                      style={{ fontFamily: "'Syne', sans-serif", color: "var(--text-primary)" }}>
                      Run a check
                    </p>
                    <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                      Tap "Run check" to scan for overdue medication or missed events.
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ─── HEATMAP ─── */}
        <section className="panel p-5">
          <div className="flex items-center gap-2 mb-2">
            <MapPin size={12} style={{ color: "var(--text-muted)" }} />
            <span className="tag">Where things happened · your space</span>
          </div>
          <Heatmap events={events} />
        </section>

      </div>

      {/* ─────────────── FOOTER ─────────────── */}
      <footer className="max-w-6xl mx-auto px-5 py-5 flex items-center justify-between"
        style={{ borderTop: "1px solid var(--border)" }}>
        <span className="text-xs" style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>
          Rewind · HackPrinceton 2026
        </span>
        <span className="text-xs" style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>
          no video ever leaves this device — only event text
        </span>
      </footer>
    </main>
  );
}
