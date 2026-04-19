"use client";

/**
 * Rewind — Command Center  ·  "Your home has a memory. Just ask."
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
const WS_URL   = API_BASE.replace(/^http/, "ws") + "/ws/events";

// ── Types ────────────────────────────────────────────────────────────────────

type EventRow = {
  id: number; ts: number; event_type: string; object: string;
  track_id?: number | null; confidence?: number | null;
  thumb_path?: string | null; location_x?: number | null; location_y?: number | null;
};
type Answer = { answer: string; confidence: "high"|"medium"|"low"; event_ids: number[]; _model?: string };
type Alert  = {
  severity: "info"|"warn"|"urgent"; title: string; body: string;
  suggested_action?: { type: string; to_name?: string; draft?: string } | null;
};

// ── Mock data ────────────────────────────────────────────────────────────────

const MOCK_OBJECTS = ["keys","phone","pill bottle","wallet","water bottle","TV remote","glasses","notebook","charger","book"];
const MOCK_ETYPES  = ["object_placed","object_removed","person_entered_frame","person_left_frame","object_picked_up","medication_taken"];
let _mockId = 1000;

const makeMock = (): EventRow => ({
  id: _mockId++, ts: Math.floor(Date.now()/1000),
  event_type: MOCK_ETYPES[Math.floor(Math.random()*MOCK_ETYPES.length)],
  object:     MOCK_OBJECTS[Math.floor(Math.random()*MOCK_OBJECTS.length)],
  location_x: Math.random(), location_y: Math.random(), thumb_path: null,
});

const SEEDS: EventRow[] = Array.from({length: 28}, (_, i) => ({
  id: i+1, ts: Math.floor(Date.now()/1000) - (28-i)*190 - Math.floor(Math.random()*80),
  event_type: MOCK_ETYPES[i % MOCK_ETYPES.length],
  object:     MOCK_OBJECTS[i % MOCK_OBJECTS.length],
  location_x: Math.random(), location_y: Math.random(), thumb_path: null,
}));

const MOCK_QA: [string, string][] = [
  ["keys",       "Your keys were placed on the counter near the sink at 3:14 PM — about 47 minutes ago."],
  ["medication", "Yes. The pill bottle was picked up at 8:02 AM. You opened it and drank water. First time since yesterday morning."],
  ["pill",       "Yes. The pill bottle was picked up at 8:02 AM. You opened it and drank water. First time since yesterday morning."],
  ["meds",       "Yes. The pill bottle was picked up at 8:02 AM. You opened it and drank water. First time since yesterday morning."],
  ["someone",    "A person entered the frame at 2:47 PM — approximately 64 minutes ago."],
  ["phone",      "Your phone was last seen on the left side of the desk at 4:11 PM, about 22 minutes ago."],
  ["wallet",     "Your wallet was placed on the kitchen counter at 1:32 PM — about 2 hours ago."],
];

// ── Utilities ────────────────────────────────────────────────────────────────

const fmtTime     = (ts: number) => new Date(ts*1000).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
const fmtRelative = (ts: number) => {
  const d = Math.floor(Date.now()/1000) - ts;
  if (d < 60)   return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d/60)}m ago`;
  return `${Math.floor(d/3600)}h ago`;
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

type SRClass = new () => { continuous:boolean; interimResults:boolean; lang:string;
  onresult:(e:any)=>void; onend:()=>void; onerror:(e:any)=>void; start:()=>void; stop:()=>void };
const getSR = (): SRClass|null =>
  typeof window === "undefined" ? null :
  (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;

const thumbURL = (p: string) => `${API_BASE}/thumb/${p}`;

// ── Event metadata ───────────────────────────────────────────────────────────

const EVENT_LABEL: Record<string,string> = {
  object_placed:"placed", object_removed:"removed", object_picked_up:"picked up",
  object_moved:"moved", person_entered_frame:"entered", person_left_frame:"left",
  medication_taken:"medication", action_detected:"action",
};
const EVENT_COLOR: Record<string,string> = {
  object_placed:"#818cf8", object_removed:"#818cf8",
  object_picked_up:"#818cf8", object_moved:"#818cf8",
  person_entered_frame:"#22d3ee", person_left_frame:"#22d3ee",
  medication_taken:"#10b981", action_detected:"#fbbf24",
};
const CONF_COLOR: Record<string,string> = {high:"#34d399",medium:"#fbbf24",low:"#f87171"};
const CONF_LABEL: Record<string,string> = {high:"High confidence",medium:"Medium",low:"Low confidence"};

const PRESETS = [
  {label:"Did I take my medication today?", icon:"💊", hero:true },
  {label:"Where did I leave my keys?",      icon:"🔑", hero:false},
  {label:"When did someone last come in?",  icon:"🚶", hero:false},
  {label:"Where is my phone?",              icon:"📱", hero:false},
];

// ── Hooks ────────────────────────────────────────────────────────────────────

function useTypewriter(text: string, speed=14) {
  const [displayed, setDisplayed] = useState("");
  const [done,      setDone]      = useState(false);
  useEffect(() => {
    setDisplayed(""); setDone(false);
    if (!text) return;
    let i = 0;
    const t = setInterval(() => {
      i++; setDisplayed(text.slice(0,i));
      if (i >= text.length) { clearInterval(t); setDone(true); }
    }, speed);
    return () => clearInterval(t);
  }, [text, speed]);
  return { displayed, done };
}

// ── Sub-components ───────────────────────────────────────────────────────────

function AuroraOrbs({dark}: {dark:boolean}) {
  const mul = dark ? 1 : 1.8;
  return (
    <div style={{position:"fixed",inset:0,overflow:"hidden",pointerEvents:"none",zIndex:0}}>
      {[
        {w:800,h:800,color:`rgba(16,185,129,${0.07*mul})`,  top:-250,left:-200, anim:"orbFloat1 28s ease-in-out infinite"},
        {w:600,h:600,color:`rgba(99,102,241,${0.055*mul})`, bottom:-150,right:-120,anim:"orbFloat2 35s ease-in-out infinite"},
        {w:450,h:450,color:`rgba(34,211,238,${0.04*mul})`,  top:"40%",right:"20%",anim:"orbFloat3 22s ease-in-out infinite"},
      ].map((o,i) => (
        <div key={i} style={{
          position:"absolute", width:o.w, height:o.h, borderRadius:"50%",
          background:`radial-gradient(circle, ${o.color} 0%, transparent 68%)`,
          filter:"blur(70px)", animation:o.anim,
          ...(o.top    !== undefined ? {top:   o.top}    : {}),
          ...(o.bottom !== undefined ? {bottom:o.bottom} : {}),
          ...(o.left   !== undefined ? {left:  o.left}   : {}),
          ...(o.right  !== undefined ? {right: o.right}  : {}),
        }} />
      ))}
    </div>
  );
}

function LiveDot({active}: {active:boolean}) {
  return (
    <span className="relative inline-flex" style={{width:10,height:10}}>
      <span className="absolute inset-0 rounded-full"
        style={{background: active ? "var(--emerald)" : "var(--text-muted)"}} />
      {active && <span className="absolute inset-0 rounded-full"
        style={{background:"var(--emerald)", animation:"pingSlow 2s ease-out infinite", opacity:0.6}} />}
    </span>
  );
}

// ── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  label, value, sub, icon: Icon, accent, glow, active,
}: {
  label:string; value:string|number; sub?:string;
  icon:React.ElementType; accent:string; glow:string; active?:boolean;
}) {
  return (
    <div style={{
      background:   "var(--surface-1)",
      border:       `1px solid ${active ? accent+"44" : "var(--border)"}`,
      borderRadius: 18,
      padding:      "22px 24px",
      boxShadow:    active ? `0 0 32px ${glow}` : "none",
      transition:   "border-color 0.3s, box-shadow 0.3s",
      position:     "relative",
      overflow:     "hidden",
    }}>
      {/* Top accent stripe */}
      <div style={{
        position:"absolute", top:0, left:0, right:0, height:3,
        background:`linear-gradient(90deg, transparent, ${accent}, transparent)`,
        opacity: active ? 1 : 0.35,
      }} />

      {/* Icon + label row */}
      <div style={{display:"flex", alignItems:"center", gap:10, marginBottom:14}}>
        <div style={{
          width:40, height:40, borderRadius:12, display:"flex",
          alignItems:"center", justifyContent:"center",
          background: `${accent}20`,
        }}>
          <Icon size={18} color={accent} />
        </div>
        <span className="section-label">{label}</span>
      </div>

      {/* Value */}
      <div style={{
        fontFamily:"'Syne', sans-serif", fontSize:"2.75rem",
        fontWeight:800, lineHeight:1, color: active ? accent : "var(--text-primary)",
        letterSpacing:"-0.02em",
      }} className="animate-count-up">
        {value}
      </div>

      {/* Sub-label */}
      {sub && (
        <div style={{
          marginTop:6, fontFamily:"'JetBrains Mono', monospace",
          fontSize:"0.7rem", color: active ? `${accent}cc` : "var(--text-muted)",
        }}>
          {sub}
        </div>
      )}
    </div>
  );
}

// ── Heatmap ──────────────────────────────────────────────────────────────────

function Heatmap({events}: {events:EventRow[]}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0,0,W,H);

    // Grid
    ctx.strokeStyle = "rgba(255,255,255,0.04)"; ctx.lineWidth = 1;
    for (let x=0; x<=W; x+=W/6) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
    for (let y=0; y<=H; y+=H/4) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

    const located = events.filter(e => e.location_x!=null && e.location_y!=null);

    located.forEach((e,idx) => {
      const x   = (e.location_x??0.5)*W, y=(e.location_y??0.5)*H;
      const med = e.event_type==="medication_taken", per=e.event_type.startsWith("person_");
      const age = Math.max(0, 1-idx/40);
      const col = med ? "16,185,129" : per ? "34,211,238" : "99,102,241";
      const r   = med ? 52 : per ? 42 : 34;
      const g   = ctx.createRadialGradient(x,y,0,x,y,r);
      g.addColorStop(0, `rgba(${col},${(med?0.7:0.42)*age})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle=g; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
    });

    located.slice(0,8).forEach((e,idx) => {
      const x=(e.location_x??0.5)*W, y=(e.location_y??0.5)*H;
      const med=e.event_type==="medication_taken", per=e.event_type.startsWith("person_");
      const a=1-idx*0.1;
      const dc = med?"rgba(16,185,129,":per?"rgba(34,211,238,":"rgba(148,163,184,";
      ctx.beginPath(); ctx.arc(x,y,5,0,Math.PI*2);
      ctx.fillStyle=`${dc}${a})`; ctx.fill();
      if (idx<5) {
        ctx.font="9px 'JetBrains Mono',monospace";
        ctx.fillStyle=`rgba(255,255,255,${a*0.55})`;
        ctx.fillText(e.object.slice(0,14), x+9, y+4);
      }
    });
  }, [events]);

  const medCount = events.filter(e=>e.event_type==="medication_taken").length;
  return (
    <div>
      <p style={{fontSize:"0.82rem",color:"var(--text-secondary)",lineHeight:1.7,marginBottom:14}}>
        Each dot is a real event location from the camera frame — no video stored, only these coordinates.{" "}
        <span style={{color:"var(--emerald)"}}>Green = medication.</span>{" "}
        <span style={{color:"var(--cyan)"}}>Cyan = person detected.</span>
      </p>
      <div style={{borderRadius:14,overflow:"hidden",position:"relative",border:"1px solid var(--border)",background:"var(--surface-2)"}}>
        <canvas ref={ref} width={900} height={210} style={{display:"block",width:"100%"}} />

        <div style={{position:"absolute",bottom:12,right:16,display:"flex",gap:16}}>
          {[["#10b981","medication"],["#22d3ee","person"],["#818cf8","object"]].map(([c,l])=>(
            <div key={l} style={{display:"flex",alignItems:"center",gap:6}}>
              <span style={{width:8,height:8,borderRadius:"50%",background:c,display:"inline-block"}} />
              <span style={{fontSize:"0.65rem",fontFamily:"'JetBrains Mono',monospace",color:"var(--text-muted)"}}>{l}</span>
            </div>
          ))}
        </div>

        {medCount>0 && (
          <div style={{
            position:"absolute",top:12,left:14,display:"flex",alignItems:"center",gap:6,
            padding:"3px 10px 3px 8px",borderRadius:999,
            background:"rgba(16,185,129,0.15)",border:"1px solid rgba(16,185,129,0.3)",
            fontSize:"0.7rem",color:"var(--emerald)",fontFamily:"'JetBrains Mono',monospace",
          }}>
            <CheckCircle2 size={11}/> {medCount} dose{medCount!==1?"s":""} today
          </div>
        )}
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Page() {
  const [events,        setEvents]        = useState<EventRow[]>(SEEDS);
  const [question,      setQuestion]      = useState("");
  const [answer,        setAnswer]        = useState<Answer|null>(null);
  const [alerts,        setAlerts]        = useState<Alert[]>([]);
  const [loading,       setLoading]       = useState(false);
  const [listening,     setListening]     = useState(false);
  const [shutterClosed, setShutterClosed] = useState(false);
  const [newEventId,    setNewEventId]    = useState<number|null>(null);
  const [connected,     setConnected]     = useState(false);
  const [agentChecked,  setAgentChecked]  = useState(false);
  const [inputFocused,  setInputFocused]  = useState(false);
  const [dark,          setDark]          = useState(true);
  // Per-request model selector. "auto" lets the backend route by default
  // (K2 primary / Claude failover). "k2" / "claude" force the path so
  // judges can watch both reasoning engines side-by-side on the same query.
  const [modelPref,     setModelPref]     = useState<"auto"|"k2"|"claude">("auto");

  // Apply theme to <html> and persist
  useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("rewind-theme") : null;
    if (saved === "light") setDark(false);
  }, []);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    localStorage.setItem("rewind-theme", dark ? "dark" : "light");
  }, [dark]);

  const recognitionRef = useRef<any>(null);
  const wsRef          = useRef<WebSocket|null>(null);
  const mockRef        = useRef<ReturnType<typeof setInterval>|null>(null);
  const reconnectDelay = useRef(1000);
  const eventsRef      = useRef<EventRow[]>(SEEDS);
  const inputRef       = useRef<HTMLInputElement>(null);

  useEffect(() => { eventsRef.current = events; }, [events]);

  const {displayed: typedAnswer, done: typingDone} = useTypewriter(answer?.answer ?? "", 13);

  const pushEvent = useCallback((ev: EventRow) => {
    setEvents(prev => { const next=[ev,...prev].slice(0,100); eventsRef.current=next; return next; });
    setNewEventId(ev.id);
    setTimeout(() => setNewEventId(null), 2000);
  }, []);

  const startMock = useCallback(() => {
    if (mockRef.current) return;
    mockRef.current = setInterval(() => pushEvent(makeMock()), 3500);
  }, [pushEvent]);

  const connectWS = useCallback(() => {
    if (wsRef.current?.readyState===WebSocket.OPEN) return;
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    ws.onopen    = () => { setConnected(true); reconnectDelay.current=1000; if (mockRef.current){clearInterval(mockRef.current);mockRef.current=null;} };
    ws.onmessage = msg => { if (typeof msg.data==="string"&&msg.data.trim()==="pong") return; try { const ev:EventRow=JSON.parse(msg.data); if (typeof ev.id==="number") pushEvent(ev); }catch{} };
    ws.onerror   = () => { setConnected(false); startMock(); };
    ws.onclose   = () => { setConnected(false); const d=Math.min(reconnectDelay.current,30000); reconnectDelay.current=d*2; setTimeout(connectWS,d); };
  }, [pushEvent, startMock]);

  useEffect(() => {
    fetch(`${API_BASE}/events?limit=80`)
      .then(r=>{if(!r.ok)throw new Error();return r.json();})
      .then((data:EventRow[])=>{if(Array.isArray(data)&&data.length>0){setEvents(data);eventsRef.current=data;}setConnected(true);})
      .catch(()=>startMock());
    connectWS();
    const ping = setInterval(()=>{ if(wsRef.current?.readyState===WebSocket.OPEN) wsRef.current.send("ping"); },15000);
    return () => { clearInterval(ping); wsRef.current?.close(); if(mockRef.current)clearInterval(mockRef.current); };
  }, [connectWS, startMock]);

  useEffect(() => {
    if (typeof window!=="undefined"&&"speechSynthesis" in window) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = ()=>window.speechSynthesis.getVoices();
    }
  }, []);

  const ask = useCallback(async (q?: string) => {
    const query = (q??question).trim();
    if (!query) return;
    setLoading(true); setAnswer(null);
    // Only send the `model` field when the user explicitly picked one.
    // Omitting it on "auto" lets the backend's default routing (which
    // honors REWIND_DEMO_MODE and k2_configured) take over.
    const body: { question: string; model?: "k2"|"claude" } = { question: query };
    if (modelPref !== "auto") body.model = modelPref;
    try {
      const r = await fetch(`${API_BASE}/query`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      if (!r.ok) throw new Error();
      const data:Answer = await r.json();
      setAnswer(data); speak(data.answer);
    } catch {
      const lower   = query.toLowerCase();
      const matched = MOCK_QA.find(([k])=>lower.includes(k));
      const ans     = matched?.[1] ?? "I didn't catch that in recent events. Try rephrasing, or check the device is watching.";
      setAnswer({answer:ans, confidence:matched?"high":"low", event_ids:matched?[42,43]:[], _model:"mock"});
      speak(ans);
    } finally { setLoading(false); }
  }, [question, modelPref]);

  function toggleListen() {
    const SR = getSR();
    if (!SR) { alert("Voice input works in Chrome / Edge. You can also type."); return; }
    if (listening&&recognitionRef.current) { recognitionRef.current.stop(); return; }
    const recog = new SR();
    recog.continuous=false; recog.interimResults=false; recog.lang="en-US";
    recog.onresult = (e:any) => { const t=e.results[0][0].transcript; setQuestion(t); setTimeout(()=>ask(t),100); };
    recog.onend    = ()=>setListening(false);
    recog.onerror  = ()=>setListening(false);
    recognitionRef.current=recog; setListening(true); recog.start();
  }

  async function checkAgent() {
    setAgentChecked(true);
    try {
      const r = await fetch(`${API_BASE}/agent/check`,{method:"POST"});
      if (!r.ok) throw new Error();
      setAlerts(await r.json());
    } catch {
      setAlerts([{
        severity:"urgent", title:"Evening dose is 6 hours overdue",
        body:"The pill bottle hasn't been touched since 8:02 AM. Evening dose is usually taken by 9 PM.",
        suggested_action:{type:"sms",to_name:"Mom",draft:"Hey Mom, just checking — did you take your evening medication? Rewind noticed the bottle hasn't been opened since this morning."},
      }]);
    }
  }

  function resolveThumb(ans: Answer): string|null {
    if (!ans.event_ids?.length) return null;
    const ev = eventsRef.current.find(e=>ans.event_ids.includes(e.id));
    return ev?.thumb_path ? thumbURL(ev.thumb_path) : null;
  }

  // Derived stats
  const totalEvents  = events.length;
  const medDoses     = events.filter(e=>e.event_type==="medication_taken").length;
  const lastPersonEv = events.find(e=>e.event_type==="person_entered_frame"||e.event_type==="person_left_frame");
  const thumbSrc     = answer ? resolveThumb(answer) : null;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <main style={{minHeight:"100vh",background:"var(--bg)",color:"var(--text-primary)"}}>
      <AuroraOrbs dark={dark} />

      <div style={{position:"relative",zIndex:1}} className="animate-fade-in">

        {/* ── HEADER ───────────────────────────────────────────────────────── */}
        <header style={{
          borderBottom:"1px solid var(--border)",
          background: dark ? "rgba(7,7,15,0.82)" : "rgba(240,240,248,0.85)",
          backdropFilter:"blur(18px)", WebkitBackdropFilter:"blur(18px)",
          position:"sticky", top:0, zIndex:50,
        }}>
          <div style={{maxWidth:1200,margin:"0 auto",padding:"0 24px",height:56,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            {/* Brand */}
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <LiveDot active={!shutterClosed} />
              <span style={{fontFamily:"'Syne',sans-serif",fontSize:"1.05rem",fontWeight:700,letterSpacing:"-0.01em"}}>
                Rewind
              </span>
              <span style={{
                fontSize:"0.7rem",padding:"2px 8px",borderRadius:999,
                background:"var(--surface-2)",border:"1px solid var(--border)",
                color:"var(--text-muted)",fontFamily:"'JetBrains Mono',monospace",
              }}>
                {connected ? "live" : "demo"}
              </span>
            </div>

            {/* Right side */}
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <div style={{display:"flex",alignItems:"center",gap:6,fontSize:"0.78rem",color:connected?"var(--emerald)":"var(--text-muted)"}}>
                {connected ? <Wifi size={13}/> : <WifiOff size={13}/>}
                <span style={{fontFamily:"'JetBrains Mono',monospace"}}>
                  {connected ? "Pi connected" : "no Pi · demo mode"}
                </span>
              </div>
              {/* Theme toggle */}
              <button onClick={()=>setDark(d=>!d)} title={dark ? "Switch to light mode" : "Switch to dark mode"} style={{
                width:36,height:36,borderRadius:10,
                display:"flex",alignItems:"center",justifyContent:"center",
                background:"var(--surface-2)",border:"1px solid var(--border)",
                color:"var(--text-secondary)",cursor:"pointer",transition:"all 0.2s",
                flexShrink:0,
              }}
              onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--border-strong)";e.currentTarget.style.color="var(--text-primary)";}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border)";e.currentTarget.style.color="var(--text-secondary)";}}>
                {dark ? <Sun size={15}/> : <Moon size={15}/>}
              </button>

              <button onClick={()=>setShutterClosed(s=>!s)} style={{
                display:"flex",alignItems:"center",gap:6,
                padding:"6px 14px",borderRadius:10,
                background:shutterClosed?"rgba(239,68,68,0.1)":"var(--surface-2)",
                border:`1px solid ${shutterClosed?"rgba(239,68,68,0.3)":"var(--border)"}`,
                color:shutterClosed?"#f87171":"var(--text-secondary)",
                fontSize:"0.8rem",cursor:"pointer",transition:"all 0.2s",
              }}>
                {shutterClosed ? <EyeOff size={13}/> : <Eye size={13}/>}
                {shutterClosed ? "Shutter closed" : "Watching"}
              </button>
            </div>
          </div>
        </header>

        {/* ── BODY ─────────────────────────────────────────────────────────── */}
        <div style={{maxWidth:1200,margin:"0 auto",padding:"32px 24px",display:"flex",flexDirection:"column",gap:24}}>

          {/* ── STATS ROW ─────────────────────────────────────────────────── */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16}}>
            <StatCard
              label="Events today" value={totalEvents} sub={`${events.filter(e=>e.ts>Date.now()/1000-3600).length} in last hour`}
              icon={Activity} accent="var(--indigo)" glow="rgba(99,102,241,0.15)"
            />
            <StatCard
              label="Doses taken" value={medDoses}
              sub={medDoses>0 ? "confirmed today ✓" : "not yet recorded"}
              icon={Zap} accent="var(--emerald)" glow="rgba(16,185,129,0.18)"
              active={medDoses>0}
            />
            <StatCard
              label="Last person"
              value={lastPersonEv ? fmtRelative(lastPersonEv.ts) : "—"}
              sub={lastPersonEv ? EVENT_LABEL[lastPersonEv.event_type] : "no one detected yet"}
              icon={Users} accent="var(--cyan)" glow="rgba(34,211,238,0.12)"
              active={!!lastPersonEv}
            />
          </div>

          {/* ── QUERY HERO ────────────────────────────────────────────────── */}
          <div style={{
            background:"var(--surface-1)",
            border:`1px solid ${inputFocused?"rgba(16,185,129,0.3)":"var(--border)"}`,
            borderRadius:20,padding:"32px",
            boxShadow:inputFocused?"0 0 48px rgba(16,185,129,0.07)":"none",
            transition:"border-color 0.25s, box-shadow 0.25s",
          }}>
            {/* Heading */}
            <div style={{marginBottom:20}}>
              <h2 style={{fontFamily:"'Syne',sans-serif",fontSize:"1.4rem",fontWeight:700,margin:0,lineHeight:1.2}}>
                Ask anything about your space
              </h2>
              <p style={{marginTop:6,fontSize:"0.85rem",color:"var(--text-secondary)"}}>
                Rewind remembers every event — just ask in plain English.
              </p>
            </div>

            {/* Input row */}
            <div style={{display:"flex",gap:10,marginBottom:16}}>
              <input
                ref={inputRef}
                value={question}
                onChange={e=>setQuestion(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&!loading&&ask()}
                onFocus={()=>setInputFocused(true)}
                onBlur={()=>setInputFocused(false)}
                placeholder="e.g. Where did I leave my keys?"
                style={{
                  flex:1, background:"var(--surface-2)",
                  border:`1px solid ${inputFocused?"var(--border-em)":"var(--border-strong)"}`,
                  borderRadius:12, padding:"15px 20px",
                  fontSize:"1rem", color:"var(--text-primary)",
                  fontFamily:"'Syne',sans-serif", caretColor:"var(--emerald)",
                  outline:"none",
                  boxShadow:inputFocused?"0 0 0 4px rgba(16,185,129,0.1)":"none",
                  transition:"border-color 0.2s, box-shadow 0.2s",
                }}
              />
              {/* Ask */}
              <button onClick={()=>ask()} disabled={loading||!question.trim()} style={{
                display:"flex",alignItems:"center",gap:8,
                padding:"15px 28px",borderRadius:12,
                background:"var(--emerald)", color:"#000",
                fontFamily:"'Syne',sans-serif",fontSize:"0.9rem",fontWeight:700,
                border:"none",cursor:"pointer",
                boxShadow:"0 2px 24px rgba(16,185,129,0.35)",
                opacity:loading||!question.trim()?0.5:1,
                transition:"all 0.15s",
              }}
              onMouseEnter={e=>{if(!loading&&question.trim()){e.currentTarget.style.filter="brightness(1.1)";e.currentTarget.style.transform="translateY(-1px)";}}}
              onMouseLeave={e=>{e.currentTarget.style.filter="none";e.currentTarget.style.transform="none";}}>
                {loading
                  ? <span className="animate-blink" style={{letterSpacing:"0.15em",fontSize:"1.1rem"}}>···</span>
                  : <><Send size={15}/> Ask</>}
              </button>
              {/* Voice */}
              <button onClick={toggleListen} title="Speak your question (Chrome/Edge)" style={{
                width:54,height:54,borderRadius:12,
                display:"flex",alignItems:"center",justifyContent:"center",
                background:listening?"rgba(239,68,68,0.15)":"var(--surface-2)",
                border:`1px solid ${listening?"rgba(239,68,68,0.4)":"var(--border-strong)"}`,
                color:listening?"#f87171":"var(--text-secondary)",
                cursor:"pointer",
                boxShadow:listening?"0 0 0 4px rgba(239,68,68,0.12)":"none",
                transform:listening?"scale(1.06)":"scale(1)",
                transition:"all 0.2s",
              }}>
                {listening ? <MicOff size={18}/> : <Mic size={18}/>}
              </button>
            </div>

            {listening && (
              <p className="animate-blink" style={{fontSize:"0.82rem",color:"#f87171",marginBottom:14,fontFamily:"'JetBrains Mono',monospace"}}>
                🎤 Listening… speak your question
              </p>
            )}

            {/* Model selector — auto (default routing), K2 Think V2, or Claude */}
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16,flexWrap:"wrap"}}>
              <span style={{
                fontSize:"0.72rem",color:"var(--text-muted)",
                fontFamily:"'JetBrains Mono',monospace",
                textTransform:"uppercase",letterSpacing:"0.1em",
              }}>
                reasoning engine
              </span>
              <div style={{display:"flex",gap:6,background:"var(--surface-2)",padding:4,borderRadius:10,border:"1px solid var(--border-strong)"}}>
                {([
                  {k:"auto"   as const, label:"Auto",   hint:"default routing (K2 primary, Claude failover)"},
                  {k:"k2"     as const, label:"K2",     hint:"force K2 Think V2 — Claude still catches on K2 failure"},
                  {k:"claude" as const, label:"Claude", hint:"force Claude 4.7 — skip K2 entirely"},
                ]).map(({k,label,hint})=>{
                  const active = modelPref===k;
                  return (
                    <button key={k} onClick={()=>setModelPref(k)} title={hint} style={{
                      padding:"6px 14px",borderRadius:7,
                      fontFamily:"'Syne',sans-serif",fontSize:"0.8rem",fontWeight:600,
                      background:active?"var(--emerald)":"transparent",
                      color:active?"#000":"var(--text-secondary)",
                      border:"none",cursor:"pointer",
                      transition:"all 0.15s",
                    }}>
                      {label}
                    </button>
                  );
                })}
              </div>
              {modelPref!=="auto" && (
                <span style={{
                  fontSize:"0.72rem",color:"var(--text-muted)",
                  fontFamily:"'JetBrains Mono',monospace",
                }}>
                  next query → {modelPref==="k2"?"MBZUAI-IFM/K2-Think-v2":"claude-opus-4-7"}
                </span>
              )}
            </div>

            {/* Preset chips */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8}}>
              {PRESETS.map(({label,icon,hero})=>(
                <button key={label}
                  onClick={()=>{setQuestion(label);setTimeout(()=>ask(label),50);}}
                  style={{
                    display:"flex",alignItems:"center",gap:10,
                    padding:"12px 16px",borderRadius:12,textAlign:"left",cursor:"pointer",
                    background:hero?"rgba(16,185,129,0.07)":"var(--surface-2)",
                    border:`1px solid ${hero?"var(--border-em)":"var(--border)"}`,
                    color:hero?"var(--text-primary)":"var(--text-secondary)",
                    fontSize:"0.85rem",fontFamily:"'Syne',sans-serif",fontWeight:500,
                    transition:"all 0.15s",
                  }}
                  onMouseEnter={e=>{e.currentTarget.style.background=hero?"rgba(16,185,129,0.12)":"var(--surface-3)";e.currentTarget.style.borderColor="var(--border-em)";e.currentTarget.style.color="var(--text-primary)";e.currentTarget.style.transform="translateY(-1px)";}}
                  onMouseLeave={e=>{e.currentTarget.style.background=hero?"rgba(16,185,129,0.07)":"var(--surface-2)";e.currentTarget.style.borderColor=hero?"var(--border-em)":"var(--border)";e.currentTarget.style.color=hero?"var(--text-primary)":"var(--text-secondary)";e.currentTarget.style.transform="none";}}>
                  <span style={{fontSize:"1.2rem"}}>{icon}</span>
                  <span style={{flex:1}}>{label}</span>
                  {hero && <span style={{
                    fontSize:"0.62rem",padding:"2px 8px",borderRadius:999,
                    background:"rgba(16,185,129,0.18)",color:"var(--emerald)",
                    fontFamily:"'JetBrains Mono',monospace",letterSpacing:"0.08em",
                  }}>DEMO</span>}
                </button>
              ))}
            </div>
          </div>

          {/* ── LOADING SKELETON ──────────────────────────────────────────── */}
          {loading && (
            <div className="animate-slide-up" style={{
              background:"var(--surface-1)",border:"1px solid var(--border-em)",
              borderRadius:20,padding:"28px",position:"relative",overflow:"hidden",
            }}>
              <div style={{
                position:"absolute",top:0,left:"-60%",width:"60%",height:"100%",
                background:"linear-gradient(90deg,transparent,rgba(16,185,129,0.07),transparent)",
                animation:"scanLine 1.6s ease-in-out infinite",
              }}/>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:"var(--emerald)",animation:"pulseEm 1.4s ease-in-out infinite"}}/>
                <span style={{fontSize:"0.82rem",color:"var(--emerald)",fontFamily:"'JetBrains Mono',monospace",letterSpacing:"0.06em"}}>
                  THINKING…
                </span>
              </div>
              {[75,55,40].map((w,i)=>(
                <div key={i} style={{height:13,borderRadius:6,background:"var(--surface-3)",marginBottom:10,width:`${w}%`}}/>
              ))}
            </div>
          )}

          {/* ── ANSWER CARD ───────────────────────────────────────────────── */}
          {answer && !loading && (
            <div className="animate-slide-up" style={{
              background:"rgba(16,185,129,0.04)",
              border:"1px solid var(--border-em)",
              borderRadius:20, padding:"32px",
              position:"relative",overflow:"hidden",
            }}>
              {/* Top glow bar */}
              <div style={{
                position:"absolute",top:0,left:0,right:0,height:3,
                background:`linear-gradient(90deg,transparent,${CONF_COLOR[answer.confidence]},transparent)`,
              }}/>
              {/* Inner top glow */}
              <div style={{
                position:"absolute",top:0,left:0,right:0,height:100,
                background:`linear-gradient(180deg,${CONF_COLOR[answer.confidence]}0c,transparent)`,
                pointerEvents:"none",
              }}/>

              {/* Meta row */}
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20,gap:12,flexWrap:"wrap"}}>
                <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                  <span style={{
                    fontSize:"0.68rem",fontFamily:"'JetBrains Mono',monospace",
                    color:"var(--emerald)",letterSpacing:"0.1em",textTransform:"uppercase",
                  }}>Rewind says</span>
                  <span style={{
                    fontSize:"0.75rem",padding:"3px 10px",borderRadius:999,
                    background:`${CONF_COLOR[answer.confidence]}1a`,
                    border:`1px solid ${CONF_COLOR[answer.confidence]}44`,
                    color:CONF_COLOR[answer.confidence],
                    fontFamily:"'JetBrains Mono',monospace",
                  }}>
                    {CONF_LABEL[answer.confidence]}
                  </span>
                  {answer._model && <span style={{fontSize:"0.72rem",color:"var(--text-muted)",fontFamily:"'JetBrains Mono',monospace"}}>
                    via {answer._model}
                  </span>}
                </div>
                <button onClick={()=>speak(answer.answer)} style={{
                  display:"flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:9,
                  background:"var(--surface-2)",border:"1px solid var(--border)",
                  color:"var(--text-secondary)",fontSize:"0.8rem",cursor:"pointer",
                  fontFamily:"'Syne',sans-serif",transition:"all 0.15s",
                }}
                onMouseEnter={e=>{e.currentTarget.style.color="var(--text-primary)";e.currentTarget.style.borderColor="var(--border-strong)";}}
                onMouseLeave={e=>{e.currentTarget.style.color="var(--text-secondary)";e.currentTarget.style.borderColor="var(--border)";}}>
                  <Volume2 size={13}/> Replay
                </button>
              </div>

              {/* Answer text + thumbnail */}
              <div style={{display:"flex",gap:24,alignItems:"flex-start"}}>
                <p style={{
                  flex:1,fontFamily:"'Syne',sans-serif",
                  fontSize:"1.75rem",fontWeight:600,lineHeight:1.5,
                  color:"var(--text-primary)",minHeight:"2.5em",
                }}>
                  {typedAnswer}
                  {!typingDone && (
                    <span className="animate-cursor" style={{
                      display:"inline-block",width:3,height:"1.5rem",
                      background:"var(--emerald)",borderRadius:2,
                      marginLeft:3,verticalAlign:"middle",
                    }}/>
                  )}
                </p>

                {thumbSrc && (
                  <div style={{
                    flexShrink:0,width:120,height:86,borderRadius:14,overflow:"hidden",
                    border:"1px solid var(--border-em)",boxShadow:"0 0 28px rgba(16,185,129,0.12)",
                    position:"relative",
                  }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={thumbSrc} alt="Location" style={{width:"100%",height:"100%",objectFit:"cover",filter:"blur(1.5px) brightness(0.7)"}}
                      onError={e=>{(e.target as HTMLImageElement).style.display="none";}}/>
                    <div style={{
                      position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",
                      width:24,height:24,borderRadius:"50%",border:"2px solid #f87171",
                      boxShadow:"0 0 16px rgba(248,113,113,0.8)",
                    }}/>
                    <div style={{position:"absolute",bottom:4,left:0,right:0,textAlign:"center",fontSize:"0.6rem",color:"rgba(255,255,255,0.5)",fontFamily:"'JetBrains Mono',monospace"}}>
                      last seen here
                    </div>
                  </div>
                )}
              </div>

              {answer.event_ids?.length>0 && (
                <p style={{marginTop:16,fontSize:"0.72rem",color:"var(--text-muted)",fontFamily:"'JetBrains Mono',monospace"}}>
                  based on events #{answer.event_ids.join(", #")}
                </p>
              )}
            </div>
          )}

          {/* ── EVENTS + ALERTS GRID ──────────────────────────────────────── */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 2fr",gap:20}}>

            {/* ─ Event timeline ─ */}
            <div style={{
              background:"var(--surface-1)",border:"1px solid var(--border)",
              borderRadius:20,padding:24,display:"flex",flexDirection:"column",
            }}>
              {/* Header */}
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <div style={{width:30,height:30,borderRadius:9,background:"rgba(255,255,255,0.05)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                    <Clock size={14} color="var(--text-secondary)"/>
                  </div>
                  <div>
                    <div style={{fontFamily:"'Syne',sans-serif",fontSize:"0.95rem",fontWeight:600}}>Recent Events</div>
                    <div style={{fontSize:"0.72rem",color:"var(--text-muted)",fontFamily:"'JetBrains Mono',monospace",marginTop:1}}>last 24 hours</div>
                  </div>
                </div>
                <div style={{
                  padding:"3px 10px",borderRadius:999,
                  background:"var(--surface-2)",border:"1px solid var(--border)",
                  fontSize:"0.72rem",color:"var(--text-muted)",fontFamily:"'JetBrains Mono',monospace",
                }}>
                  {events.length}
                </div>
              </div>

              {/* List */}
              <div style={{flex:1,overflowY:"auto",maxHeight:520}}>
                {events.map((e, idx) => {
                  const isNew    = newEventId === e.id;
                  const isMed    = e.event_type === "medication_taken";
                  const accent   = EVENT_COLOR[e.event_type] ?? "var(--text-muted)";
                  const badgeBg  = `${accent}1a`;
                  return (
                    <div key={e.id} style={{
                      padding:"12px 8px",
                      borderBottom:"1px solid var(--border)",
                      background:isNew?"rgba(16,185,129,0.07)":"transparent",
                      borderRadius:isNew?10:undefined,
                      transition:"background 0.4s",
                      animation:isNew?"eventIn 0.3s ease forwards":undefined,
                    }}>
                      <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
                        {/* Event type badge */}
                        <span className="event-badge" style={{
                          background:badgeBg,color:accent,
                          border:`1px solid ${accent}30`,marginTop:1,flexShrink:0,
                        }}>
                          {EVENT_LABEL[e.event_type] ?? e.event_type.replace(/_/g," ")}
                        </span>

                        {/* Object + time */}
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{
                            fontFamily:"'Syne',sans-serif",
                            fontSize:"0.9rem",fontWeight:600,
                            color:isMed?"var(--emerald)":"var(--text-primary)",
                            overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
                          }}>
                            {e.object}
                          </div>
                          <div style={{
                            fontSize:"0.7rem",color:"var(--text-muted)",
                            fontFamily:"'JetBrains Mono',monospace",marginTop:2,
                          }}>
                            {fmtTime(e.ts)} · {fmtRelative(e.ts)}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {events.length === 0 && (
                  <div style={{padding:"40px 0",textAlign:"center",color:"var(--text-muted)",fontSize:"0.85rem"}}>
                    <p>No events yet.</p>
                    <p style={{marginTop:4,fontSize:"0.78rem"}}>Place something in view of the camera.</p>
                  </div>
                )}
              </div>
            </div>

            {/* ─ Proactive alerts ─ */}
            <div style={{
              background:"var(--surface-1)",border:"1px solid var(--border)",
              borderRadius:20,padding:24,
            }}>
              {/* Header */}
              <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:20,gap:16}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{width:30,height:30,borderRadius:9,background:"rgba(255,255,255,0.05)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                    <AlertTriangle size={14} color="var(--text-secondary)"/>
                  </div>
                  <div>
                    <div style={{fontFamily:"'Syne',sans-serif",fontSize:"0.95rem",fontWeight:600}}>Proactive Alerts</div>
                    <div style={{fontSize:"0.72rem",color:"var(--text-muted)",fontFamily:"'JetBrains Mono',monospace",marginTop:1}}>
                      checks schedule against events
                    </div>
                  </div>
                </div>
                <button onClick={checkAgent} style={{
                  display:"flex",alignItems:"center",gap:7,
                  padding:"9px 18px",borderRadius:11,flexShrink:0,
                  background:agentChecked&&alerts.length===0?"rgba(16,185,129,0.08)":"var(--surface-2)",
                  border:`1px solid ${agentChecked&&alerts.length===0?"var(--border-em)":"var(--border-strong)"}`,
                  color:agentChecked&&alerts.length===0?"var(--emerald)":"var(--text-primary)",
                  fontFamily:"'Syne',sans-serif",fontSize:"0.85rem",fontWeight:600,cursor:"pointer",
                  transition:"all 0.2s",
                }}
                onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--border-em)";e.currentTarget.style.transform="translateY(-1px)";}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor=agentChecked&&alerts.length===0?"var(--border-em)":"var(--border-strong)";e.currentTarget.style.transform="none";}}>
                  {agentChecked&&alerts.length===0 ? <><CheckCircle2 size={14}/> All clear</> : "Run check"}
                </button>
              </div>

              {/* Alerts */}
              {alerts.length > 0 ? (
                <div style={{display:"flex",flexDirection:"column",gap:14}}>
                  {alerts.map((a,i) => {
                    const urgent = a.severity==="urgent";
                    const ac     = urgent?"#f87171":"#fbbf24";
                    return (
                      <div key={i} className={`animate-slide-up ${urgent?"card-urgent":"card-warn"}`}
                        style={{padding:20,animationDelay:`${i*60}ms`}}>
                        <div style={{display:"flex",gap:14,marginBottom:a.suggested_action?.draft?16:0}}>
                          <div style={{
                            width:36,height:36,borderRadius:"50%",flexShrink:0,
                            display:"flex",alignItems:"center",justifyContent:"center",
                            background:`${ac}20`,
                          }}>
                            <AlertTriangle size={15} color={ac}/>
                          </div>
                          <div>
                            <div style={{fontFamily:"'Syne',sans-serif",fontSize:"0.95rem",fontWeight:700,color:ac,marginBottom:6}}>
                              {a.title}
                            </div>
                            <div style={{fontSize:"0.85rem",color:"var(--text-secondary)",lineHeight:1.7}}>
                              {a.body}
                            </div>
                          </div>
                        </div>

                        {a.suggested_action?.draft && (
                          <div style={{
                            marginTop:16,borderRadius:12,padding:16,
                            background:"rgba(0,0,0,0.25)",border:"1px solid var(--border)",
                          }}>
                            <div style={{fontSize:"0.72rem",color:"var(--text-muted)",fontFamily:"'JetBrains Mono',monospace",marginBottom:8}}>
                              Draft message to {a.suggested_action.to_name}
                            </div>
                            <p style={{fontSize:"0.88rem",color:"var(--text-secondary)",lineHeight:1.75,fontStyle:"italic",marginBottom:14}}>
                              "{a.suggested_action.draft}"
                            </p>
                            <button onClick={async()=>{try{await fetch(`${API_BASE}/agent/action`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:a.suggested_action})});}catch{}}} style={{
                              display:"flex",alignItems:"center",gap:8,
                              padding:"9px 18px",borderRadius:10,cursor:"pointer",
                              background:`${ac}1a`,border:`1px solid ${ac}44`,color:ac,
                              fontFamily:"'Syne',sans-serif",fontSize:"0.85rem",fontWeight:600,
                              transition:"all 0.15s",
                            }}
                            onMouseEnter={e=>{e.currentTarget.style.filter="brightness(1.15)";e.currentTarget.style.transform="translateY(-1px)";}}
                            onMouseLeave={e=>{e.currentTarget.style.filter="none";e.currentTarget.style.transform="none";}}>
                              <Send size={13}/> Send to {a.suggested_action.to_name}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"56px 20px",textAlign:"center"}}>
                  {agentChecked ? (
                    <>
                      <div className="animate-pulse-em" style={{
                        width:60,height:60,borderRadius:"50%",
                        display:"flex",alignItems:"center",justifyContent:"center",marginBottom:16,
                        background:"rgba(16,185,129,0.1)",border:"1px solid var(--border-em)",
                      }}>
                        <CheckCircle2 size={26} color="var(--emerald)"/>
                      </div>
                      <p style={{fontFamily:"'Syne',sans-serif",fontSize:"1rem",fontWeight:700,marginBottom:8}}>All clear</p>
                      <p style={{fontSize:"0.83rem",color:"var(--text-muted)"}}>All scheduled items are on track.</p>
                    </>
                  ) : (
                    <>
                      <div style={{
                        width:60,height:60,borderRadius:"50%",
                        display:"flex",alignItems:"center",justifyContent:"center",marginBottom:16,
                        background:"var(--surface-2)",border:"1px solid var(--border)",
                      }}>
                        <AlertTriangle size={24} color="var(--text-muted)"/>
                      </div>
                      <p style={{fontFamily:"'Syne',sans-serif",fontSize:"1rem",fontWeight:700,marginBottom:8}}>Run a proactive check</p>
                      <p style={{fontSize:"0.83rem",color:"var(--text-muted)",maxWidth:300,lineHeight:1.7}}>
                        Rewind will scan for overdue medication, missed routines, or anything that needs your attention.
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>

          </div>

          {/* ── HEATMAP ───────────────────────────────────────────────────── */}
          <div style={{
            background:"var(--surface-1)",border:"1px solid var(--border)",
            borderRadius:20,padding:24,
          }}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
              <div style={{width:30,height:30,borderRadius:9,background:"rgba(255,255,255,0.05)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                <MapPin size={14} color="var(--text-secondary)"/>
              </div>
              <div>
                <div style={{fontFamily:"'Syne',sans-serif",fontSize:"0.95rem",fontWeight:600}}>Spatial Activity Map</div>
                <div style={{fontSize:"0.72rem",color:"var(--text-muted)",fontFamily:"'JetBrains Mono',monospace",marginTop:1}}>where things happened in your space</div>
              </div>
            </div>
            <Heatmap events={events}/>
          </div>

        </div>

        {/* ── FOOTER ───────────────────────────────────────────────────────── */}
        <footer style={{
          maxWidth:1200,margin:"0 auto",padding:"20px 24px",
          borderTop:"1px solid var(--border)",
          display:"flex",alignItems:"center",justifyContent:"space-between",
        }}>
          <span style={{fontSize:"0.78rem",color:"var(--text-muted)",fontFamily:"'JetBrains Mono',monospace"}}>
            Rewind · HackPrinceton 2026
          </span>
          <div style={{display:"flex",alignItems:"center",gap:6,fontSize:"0.78rem",color:"var(--text-muted)",fontFamily:"'JetBrains Mono',monospace"}}>
            <span style={{width:6,height:6,borderRadius:"50%",background:"var(--emerald)",display:"inline-block"}}/>
            no video ever leaves this device — only event text
          </div>
        </footer>

      </div>
    </main>
  );
}
