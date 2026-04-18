"use client";

/**
 * Rewind — Command Center (Next.js 14 + App Router + Tailwind)
 * Owner: Jeeyan
 *
 * Run:
 *   cd frontend
 *   npm install
 *   cp .env.local.example .env.local   # set NEXT_PUBLIC_REWIND_API to the Pi's IP
 *   npm run dev                        # http://localhost:3000
 */

import { useEffect, useRef, useState } from "react";
import {
  Eye, EyeOff, Mic, MicOff, Send, AlertCircle, Clock, Volume2,
} from "lucide-react";

const API = process.env.NEXT_PUBLIC_REWIND_API ?? "http://localhost:8000";
const WS  = API.replace("http", "ws") + "/ws/events";

// ---------- Types ----------

type EventRow = {
  id: number;
  ts: number;
  event_type: string;
  object: string;
  track_id?: number | null;
  thumb_path?: string | null;
};

type Answer = {
  answer: string;
  confidence: "high" | "medium" | "low";
  event_ids: number[];
  _model?: string;
};

type Alert = {
  severity: "info" | "warn" | "urgent";
  title: string;
  body: string;
  suggested_action?: {
    type: string;
    to_name?: string;
    draft?: string;
  } | null;
};

// ---------- Utilities ----------

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.0;
  u.pitch = 1.0;
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(v =>
    /Samantha|Jenny|Google US English|Microsoft Aria/i.test(v.name)
  );
  if (preferred) u.voice = preferred;
  window.speechSynthesis.speak(u);
}

type SRClass = new () => {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: (e: any) => void;
  onend: () => void;
  onerror: (e: any) => void;
  start: () => void;
  stop: () => void;
};

function getSR(): SRClass | null {
  if (typeof window === "undefined") return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

const CONFIDENCE_COLORS = {
  high:   "text-emerald-400",
  medium: "text-amber-400",
  low:    "text-red-400",
};

const PRESET_QUERIES = [
  "Where did I leave my keys?",
  "Did I take my medication today?",
  "When did someone last come in?",
];

// ---------- Sub-components ----------

function StatusDot({ active }: { active: boolean }) {
  return (
    <span className="relative flex items-center justify-center w-2.5 h-2.5">
      <span
        className="absolute inline-block w-2.5 h-2.5 rounded-full"
        style={{ background: active ? "var(--emerald)" : "#3f3f50" }}
      />
      {active && (
        <span
          className="absolute inline-block w-2.5 h-2.5 rounded-full animate-ping opacity-60"
          style={{ background: "var(--emerald)" }}
        />
      )}
    </span>
  );
}

function SectionLabel({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <span style={{ color: "var(--text-muted)" }}>{icon}</span>
      <span className="tag">{label}</span>
    </div>
  );
}

// ---------- Main Page ----------

export default function Page() {
  const [events,       setEvents]       = useState<EventRow[]>([]);
  const [question,     setQuestion]     = useState("");
  const [answer,       setAnswer]       = useState<Answer | null>(null);
  const [alerts,       setAlerts]       = useState<Alert[]>([]);
  const [loading,      setLoading]      = useState(false);
  const [listening,    setListening]    = useState(false);
  const [shutterClosed, setShutterClosed] = useState(false);
  const [newEventId,   setNewEventId]   = useState<number | null>(null);
  const recognitionRef = useRef<any>(null);
  const wsRef          = useRef<WebSocket | null>(null);

  // Initial load + WebSocket
  useEffect(() => {
    fetch(`${API}/events?limit=80`)
      .then(r => r.json())
      .then(setEvents)
      .catch(() => {});

    const ws = new WebSocket(WS);
    wsRef.current = ws;
    ws.onmessage = msg => {
      const ev: EventRow = JSON.parse(msg.data);
      setEvents(prev => [ev, ...prev].slice(0, 100));
      setNewEventId(ev.id);
      setTimeout(() => setNewEventId(null), 1200);
    };
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 15_000);
    return () => { clearInterval(ping); ws.close(); };
  }, []);

  // Pre-load voice list (Chrome async)
  useEffect(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    }
  }, []);

  async function ask(q?: string) {
    const query = q ?? question;
    if (!query.trim()) return;
    setLoading(true);
    setAnswer(null);
    try {
      const r = await fetch(`${API}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: query }),
      });
      const data: Answer = await r.json();
      setAnswer(data);
      speak(data.answer);
    } catch {
      setAnswer({
        answer: "Couldn't reach the Rewind device. Check the Pi is on your network.",
        confidence: "low",
        event_ids: [],
      });
    } finally {
      setLoading(false);
    }
  }

  function toggleListen() {
    const SR = getSR();
    if (!SR) {
      alert("Speech recognition not supported in this browser. Use Chrome.");
      return;
    }
    if (listening && recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }
    const recog = new SR();
    recog.continuous = false;
    recog.interimResults = false;
    recog.lang = "en-US";
    recog.onresult = (e: any) => {
      const transcript = e.results[0][0].transcript;
      setQuestion(transcript);
      setTimeout(() => ask(transcript), 100);
    };
    recog.onend  = () => setListening(false);
    recog.onerror = () => setListening(false);
    recognitionRef.current = recog;
    setListening(true);
    recog.start();
  }

  async function checkAgent() {
    const r = await fetch(`${API}/agent/check`, { method: "POST" });
    setAlerts(await r.json());
  }

  return (
    <main
      className="min-h-screen p-5 md:p-8 animate-fade-in"
      style={{ background: "var(--surface)", color: "var(--text-primary)" }}
    >
      {/* ── Header ── */}
      <header className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <div className="relative flex items-center">
            <StatusDot active={!shutterClosed} />
          </div>
          <div>
            <h1
              className="font-display text-2xl font-700 tracking-tight leading-none"
              style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700 }}
            >
              Rewind
            </h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              ambient memory · on-device
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Live indicator */}
          <div
            className="hidden sm:flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md"
            style={{ background: "var(--surface-2)", color: "var(--text-secondary)" }}
          >
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ background: shutterClosed ? "#3f3f50" : "var(--emerald)" }}
            />
            {shutterClosed ? "paused" : "live"}
          </div>

          {/* Shutter toggle */}
          <button
            onClick={() => setShutterClosed(s => !s)}
            className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg transition-all duration-200"
            style={{
              background: shutterClosed ? "rgba(239,68,68,0.08)" : "var(--surface-2)",
              border: `1px solid ${shutterClosed ? "rgba(239,68,68,0.2)" : "var(--border)"}`,
              color: shutterClosed ? "#f87171" : "var(--text-secondary)",
            }}
          >
            {shutterClosed ? <EyeOff size={13} /> : <Eye size={13} />}
            {shutterClosed ? "Shutter closed" : "Watching"}
          </button>
        </div>
      </header>

      {/* ── Grid ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* ── Left: Event timeline ── */}
        <section className="lg:col-span-1 panel p-5 flex flex-col">
          <SectionLabel icon={<Clock size={11} />} label="Event stream" />

          <ul className="space-y-0 max-h-[68vh] overflow-y-auto flex-1 -mx-1 px-1">
            {events.map((e, idx) => (
              <li
                key={e.id}
                className="grid py-2 transition-all duration-500"
                style={{
                  gridTemplateColumns: "5rem 1fr",
                  gap: "0.75rem",
                  borderBottom: "1px solid var(--border)",
                  opacity: newEventId === e.id ? 1 : idx === 0 ? 0.95 : Math.max(0.3, 1 - idx * 0.025),
                  background: newEventId === e.id
                    ? "rgba(16,185,129,0.06)"
                    : "transparent",
                  borderRadius: newEventId === e.id ? "6px" : undefined,
                }}
              >
                <span className="text-xs tabular-nums shrink-0" style={{ color: "var(--text-muted)" }}>
                  {fmtTime(e.ts)}
                </span>
                <div className="min-w-0">
                  <div
                    className="text-xs truncate mb-0.5"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {e.event_type}
                  </div>
                  <div
                    className="text-xs truncate"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {e.object}
                  </div>
                </div>
              </li>
            ))}
            {events.length === 0 && (
              <li className="text-xs italic py-4" style={{ color: "var(--text-muted)" }}>
                No events yet. Place something in view.
              </li>
            )}
          </ul>
        </section>

        {/* ── Right: Query + Agent ── */}
        <section className="lg:col-span-2 space-y-5">

          {/* Query panel */}
          <div className="panel p-5">
            <SectionLabel icon={<Mic size={11} />} label="Ask Rewind" />

            {/* Input row */}
            <div className="flex gap-2 mb-4">
              <input
                value={question}
                onChange={e => setQuestion(e.target.value)}
                onKeyDown={e => e.key === "Enter" && ask()}
                placeholder="Where did I leave my keys?"
                className="flex-1 text-xs px-4 py-3 rounded-lg outline-none transition-all duration-200"
                style={{
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  color: "var(--text-primary)",
                  caretColor: "var(--emerald)",
                }}
                onFocus={e => {
                  e.currentTarget.style.borderColor = "var(--border-em)";
                  e.currentTarget.style.boxShadow = "0 0 0 3px rgba(16,185,129,0.08)";
                }}
                onBlur={e => {
                  e.currentTarget.style.borderColor = "var(--border)";
                  e.currentTarget.style.boxShadow = "none";
                }}
              />

              {/* Ask */}
              <button
                onClick={() => ask()}
                disabled={loading}
                className="flex items-center gap-1.5 text-xs px-4 py-3 rounded-lg font-medium transition-all duration-200 disabled:opacity-40"
                style={{
                  background: "var(--emerald)",
                  color: "#000",
                  fontFamily: "'Syne', sans-serif",
                  fontWeight: 600,
                }}
                onMouseEnter={e => !loading && (e.currentTarget.style.filter = "brightness(1.1)")}
                onMouseLeave={e => (e.currentTarget.style.filter = "none")}
              >
                {loading ? (
                  <span className="animate-blink">···</span>
                ) : (
                  <><Send size={13} /> Ask</>
                )}
              </button>

              {/* Mic */}
              <button
                onClick={toggleListen}
                title="Speak your question (Chrome only)"
                className="flex items-center gap-1.5 text-xs px-4 py-3 rounded-lg transition-all duration-200"
                style={{
                  background: listening ? "rgba(239,68,68,0.12)" : "var(--surface-2)",
                  border: `1px solid ${listening ? "rgba(239,68,68,0.3)" : "var(--border)"}`,
                  color: listening ? "#f87171" : "var(--text-secondary)",
                  animation: listening ? "blink 1.2s ease-in-out infinite" : undefined,
                }}
              >
                {listening ? <MicOff size={13} /> : <Mic size={13} />}
              </button>
            </div>

            {/* Preset chips */}
            <div className="flex flex-wrap gap-2">
              {PRESET_QUERIES.map(q => (
                <button
                  key={q}
                  onClick={() => { setQuestion(q); setTimeout(() => ask(q), 50); }}
                  className="text-xs px-3 py-1.5 rounded-full transition-all duration-200"
                  style={{
                    background: "var(--surface-2)",
                    border: "1px solid var(--border)",
                    color: "var(--text-secondary)",
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = "var(--border-em)";
                    e.currentTarget.style.color = "var(--text-primary)";
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = "var(--border)";
                    e.currentTarget.style.color = "var(--text-secondary)";
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>

          {/* Answer card */}
          {answer && (
            <div className="panel-em p-5 animate-slide-up">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <span className="tag">Answer</span>
                  <span
                    className={`text-xs font-mono ${CONFIDENCE_COLORS[answer.confidence]}`}
                  >
                    {answer.confidence} confidence
                  </span>
                  {answer._model && (
                    <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                      · {answer._model}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => speak(answer.answer)}
                  title="Replay audio"
                  className="p-1.5 rounded-md transition-colors duration-150"
                  style={{ color: "var(--text-muted)" }}
                  onMouseEnter={e => (e.currentTarget.style.color = "var(--emerald)")}
                  onMouseLeave={e => (e.currentTarget.style.color = "var(--text-muted)")}
                >
                  <Volume2 size={13} />
                </button>
              </div>

              <p
                className="text-base leading-relaxed"
                style={{
                  fontFamily: "'Syne', sans-serif",
                  fontWeight: 400,
                  color: "var(--text-primary)",
                }}
              >
                {answer.answer}
              </p>

              {answer.event_ids?.length > 0 && (
                <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
                  refs: {answer.event_ids.join(", ")}
                </p>
              )}
            </div>
          )}

          {/* Agent panel */}
          <div className="panel p-5">
            <div className="flex items-center justify-between mb-4">
              <SectionLabel icon={<AlertCircle size={11} />} label="Proactive agent" />
              <button
                onClick={checkAgent}
                className="text-xs px-3 py-1.5 rounded-lg transition-all duration-200 -mt-4"
                style={{
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  color: "var(--text-secondary)",
                }}
                onMouseEnter={e => (e.currentTarget.style.color = "var(--text-primary)")}
                onMouseLeave={e => (e.currentTarget.style.color = "var(--text-secondary)")}
              >
                Run check
              </button>
            </div>

            <div className="space-y-3">
              {alerts.map((a, i) => (
                <div
                  key={i}
                  className="rounded-lg p-4 animate-slide-up"
                  style={{
                    background: a.severity === "urgent"
                      ? "rgba(239,68,68,0.06)"
                      : "rgba(245,158,11,0.06)",
                    border: `1px solid ${
                      a.severity === "urgent"
                        ? "rgba(239,68,68,0.2)"
                        : "rgba(245,158,11,0.2)"
                    }`,
                  }}
                >
                  <div
                    className="text-sm font-medium mb-1"
                    style={{
                      fontFamily: "'Syne', sans-serif",
                      color: a.severity === "urgent" ? "#fca5a5" : "#fcd34d",
                    }}
                  >
                    {a.title}
                  </div>
                  <div className="text-xs" style={{ color: "var(--text-secondary)" }}>
                    {a.body}
                  </div>
                  {a.suggested_action?.draft && (
                    <div className="mt-3">
                      <div className="text-xs mb-1.5" style={{ color: "var(--text-muted)" }}>
                        Suggested to {a.suggested_action.to_name}:
                      </div>
                      <div
                        className="text-xs italic pl-3"
                        style={{
                          color: "var(--text-secondary)",
                          borderLeft: "2px solid var(--border)",
                        }}
                      >
                        "{a.suggested_action.draft}"
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {alerts.length === 0 && (
                <p className="text-xs italic" style={{ color: "var(--text-muted)" }}>
                  No alerts. All scheduled items on track.
                </p>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* ── Footer ── */}
      <footer
        className="mt-10 flex items-center justify-between text-xs"
        style={{ color: "var(--text-muted)", borderTop: "1px solid var(--border)", paddingTop: "1.25rem" }}
      >
        <span>Rewind · HackPrinceton 2026</span>
        <span>no video ever leaves this device</span>
      </footer>
    </main>
  );
}
