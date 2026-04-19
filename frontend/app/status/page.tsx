"use client";

/**
 * /status — Ambient "glass pane" display for the phone-stand beside Recall.
 * Silent, output-only. Connects to ws://<host>/ws/state (backend CONTRACTS §3e).
 * Falls back to an auto-demo cycle when the backend is unreachable.
 *
 * Visual language matches the main site: warm editorial palette (sage / ochre /
 * clay / cream), Fraunces display serif, italic subtext. Background stays near-
 * black so the phone's OLED does the heavy lifting and the particles glow.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";

// ── Config ────────────────────────────────────────────────────────────────────

const API_BASE   = (process.env.NEXT_PUBLIC_REWIND_API ?? "http://localhost:8000").replace(/\/$/, "");
const WS_STATE   = API_BASE.replace(/^http/, "ws") + "/ws/state";
const N          = 900;
const ANSWER_TTL = 15_000;
const ALERT_TTL  = 10_000;

// ── Types ─────────────────────────────────────────────────────────────────────

type RState   = "idle" | "listening" | "thinking" | "answer" | "alert";
type StateMsg = { state: RState; text?: string };

// ── Demo cycle ────────────────────────────────────────────────────────────────

const DEMO: { state: RState; text?: string; dur: number }[] = [
  { state: "idle",      dur: 4500 },
  { state: "listening", dur: 2400 },
  { state: "thinking",  dur: 2200 },
  { state: "answer",    text: "Your pill bottle was picked up at 8:02 AM — about four hours ago.", dur: 8500 },
  { state: "idle",      dur: 3500 },
  { state: "listening", dur: 2000 },
  { state: "thinking",  dur: 2400 },
  { state: "answer",    text: "Your keys were placed on the counter near the sink at 3:14 PM.", dur: 8500 },
  { state: "alert",     text: "Evening dose — six hours overdue.", dur: 6000 },
];

// ── Particle helpers ──────────────────────────────────────────────────────────

// RGB 0-1. Palette mapped to the site's warm tokens:
//   idle      → sage     (#9BAD82)    calm
//   listening → sage-hi  (#B5C89A)    brighter, attentive
//   thinking  → ochre    (#CB8B53)    warm effort
//   answer    → cream    (#F0E4D1)    near-paper, text takes stage
//   alert     → clay     (#C66548)    warm red, not neon
const COLORS: Record<RState, [number, number, number]> = {
  idle:      [0.608, 0.678, 0.510],
  listening: [0.710, 0.784, 0.604],
  thinking:  [0.796, 0.545, 0.325],
  answer:    [0.941, 0.894, 0.820],
  alert:     [0.776, 0.396, 0.282],
};

function computeTargets(state: RState): Float32Array {
  const a = new Float32Array(N * 3);
  switch (state) {
    case "idle": {
      // Uniform breathing sphere
      for (let i = 0; i < N; i++) {
        const theta = Math.acos(2 * Math.random() - 1);
        const phi   = 2 * Math.PI * Math.random();
        const r     = 1.9 + Math.random() * 0.35;
        a[i*3]   = r * Math.sin(theta) * Math.cos(phi);
        a[i*3+1] = r * Math.sin(theta) * Math.sin(phi);
        a[i*3+2] = r * Math.cos(theta);
      }
      break;
    }
    case "listening": {
      // Concentric rings in the XZ plane — ripples outward from center
      const RINGS = 8;
      for (let i = 0; i < N; i++) {
        const ring    = i % RINGS;
        const radius  = 0.3 + ring * 0.36;
        const perRing = Math.floor(N / RINGS);
        const angle   = ((i % perRing) / perRing) * Math.PI * 2 + (Math.random() - 0.5) * 0.1;
        const jitter  = (Math.random() - 0.5) * 0.07;
        a[i*3]   = Math.cos(angle) * (radius + jitter);
        a[i*3+1] = (Math.random() - 0.5) * 0.1;
        a[i*3+2] = Math.sin(angle) * (radius + jitter);
      }
      break;
    }
    case "thinking": {
      // Double helix — threads of thought braiding together
      for (let i = 0; i < N; i++) {
        const strand = i % 2;
        const t      = Math.floor(i / 2) / (N / 2);
        const turns  = 5;
        const angle  = t * Math.PI * 2 * turns + strand * Math.PI;
        const r      = 0.35 + t * 1.85;
        a[i*3]   = Math.cos(angle) * r;
        a[i*3+1] = (t - 0.5) * 3.8;
        a[i*3+2] = Math.sin(angle) * r;
      }
      break;
    }
    case "answer": {
      // Particles drift far out; the text takes center stage
      for (let i = 0; i < N; i++) {
        const theta = Math.acos(2 * Math.random() - 1);
        const phi   = 2 * Math.PI * Math.random();
        const r     = 3.5 + Math.random() * 2.0;
        a[i*3]   = r * Math.sin(theta) * Math.cos(phi);
        a[i*3+1] = r * Math.sin(theta) * Math.sin(phi);
        a[i*3+2] = r * Math.cos(theta);
      }
      break;
    }
    case "alert": {
      // Tight, pulsing cluster — insistent but warm
      for (let i = 0; i < N; i++) {
        const theta = Math.acos(2 * Math.random() - 1);
        const phi   = 2 * Math.PI * Math.random();
        const r     = 0.6 + Math.random() * 0.55;
        a[i*3]   = r * Math.sin(theta) * Math.cos(phi);
        a[i*3+1] = r * Math.sin(theta) * Math.sin(phi);
        a[i*3+2] = r * Math.cos(theta);
      }
      break;
    }
  }
  return a;
}

// Radial glow sprite — baked once onto a canvas, reused across all particles.
function makeSprite(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0,   "rgba(255,255,255,1)");
  g.addColorStop(0.3, "rgba(255,255,255,0.75)");
  g.addColorStop(0.7, "rgba(255,255,255,0.2)");
  g.addColorStop(1,   "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StatusPage() {
  const [curState,   setCurState]   = useState<RState>("idle");
  const [curText,    setCurText]    = useState("");
  const [textVis,    setTextVis]    = useState(false);
  const [connected,  setConnected]  = useState(false);

  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const stateRef    = useRef<RState>("idle");
  const targetsRef  = useRef<Float32Array>(computeTargets("idle"));
  const wsRef       = useRef<WebSocket | null>(null);
  const ttlRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const demoRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const demoIdx     = useRef(0);
  const reconnectMs = useRef(800);

  // ── State transitions ──────────────────────────────────────────────────
  const handleMsg = useCallback((msg: StateMsg) => {
    if (ttlRef.current) clearTimeout(ttlRef.current);
    setCurState(msg.state);
    setCurText(msg.text ?? "");
  }, []);

  useEffect(() => {
    if (curState === "answer") {
      ttlRef.current = setTimeout(() => { setCurState("idle"); setCurText(""); }, ANSWER_TTL);
    }
    if (curState === "alert") {
      ttlRef.current = setTimeout(() => { setCurState("idle"); setCurText(""); }, ALERT_TTL);
    }
    setTextVis(curState === "answer" || curState === "alert");
    stateRef.current   = curState;
    targetsRef.current = computeTargets(curState);
    return () => { if (ttlRef.current) clearTimeout(ttlRef.current); };
  }, [curState]);

  // ── Three.js scene ─────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    // Warm near-black background — phone OLED loves it, keeps our palette consistent
    renderer.setClearColor(0x0D0906, 1);

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.z = 5.5;
    scene.fog = new THREE.FogExp2(0x0D0906, 0.06);

    const sprite = makeSprite();

    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const initTargets = computeTargets("idle");
    for (let i = 0; i < N * 3; i++) {
      pos[i] = initTargets[i];
      col[i] = COLORS.idle[i % 3];
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color",    new THREE.BufferAttribute(col, 3));

    const mat = new THREE.PointsMaterial({
      size:         0.06,
      map:          sprite,
      vertexColors: true,
      transparent:  true,
      opacity:      0.95,
      blending:     THREE.AdditiveBlending,
      depthWrite:   false,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    scene.add(points);

    // Halo layer — larger, dimmer mirror of the main cloud
    const haloPosArr = new Float32Array(N * 3);
    const haloColArr = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) haloPosArr[i] = pos[i];
    for (let i = 0; i < N; i++) {
      haloColArr[i*3]   = COLORS.idle[0] * 0.3;
      haloColArr[i*3+1] = COLORS.idle[1] * 0.3;
      haloColArr[i*3+2] = COLORS.idle[2] * 0.3;
    }
    const haloGeo = new THREE.BufferGeometry();
    haloGeo.setAttribute("position", new THREE.BufferAttribute(haloPosArr, 3));
    haloGeo.setAttribute("color",    new THREE.BufferAttribute(haloColArr, 3));
    const haloMat = new THREE.PointsMaterial({
      size: 0.18, map: sprite, vertexColors: true,
      transparent: true, opacity: 0.18,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    const halo = new THREE.Points(haloGeo, haloMat);
    scene.add(halo);

    const clock = new THREE.Clock();
    let frame: number;

    function animate() {
      frame = requestAnimationFrame(animate);
      const t  = clock.getElapsedTime();
      const st = stateRef.current;
      const tg = targetsRef.current;
      const pA = geo.attributes.position.array as Float32Array;
      const cA = geo.attributes.color.array as Float32Array;
      const hP = haloGeo.attributes.position.array as Float32Array;
      const hC = haloGeo.attributes.color.array as Float32Array;

      const lerpSpeed = st === "thinking" ? 0.065 : st === "alert" ? 0.055 : st === "answer" ? 0.022 : 0.02;
      const tc = COLORS[st];

      for (let i = 0; i < N; i++) {
        const x = i*3, y = x+1, z = x+2;

        pA[x] += (tg[x] - pA[x]) * lerpSpeed;
        pA[y] += (tg[y] - pA[y]) * lerpSpeed;
        pA[z] += (tg[z] - pA[z]) * lerpSpeed;

        if (st === "listening") {
          const ring = i % 8;
          const wave = Math.sin(t * 3.5 - ring * 0.55) * 0.055;
          pA[x] += pA[x] * wave * 0.04;
          pA[z] += pA[z] * wave * 0.04;
        }
        if (st === "alert") {
          pA[x] += (Math.random() - 0.5) * 0.05;
          pA[y] += (Math.random() - 0.5) * 0.05;
          pA[z] += (Math.random() - 0.5) * 0.05;
        }
        if (st === "idle") {
          const breath = 1 + Math.sin(t * 0.8) * 0.015;
          pA[x] *= breath;
          pA[y] *= breath;
          pA[z] *= breath;
        }

        cA[x] += (tc[0] - cA[x]) * 0.04;
        cA[y] += (tc[1] - cA[y]) * 0.04;
        cA[z] += (tc[2] - cA[z]) * 0.04;

        hP[x] = pA[x]; hP[y] = pA[y]; hP[z] = pA[z];
        hC[x] = cA[x] * 0.3;
        hC[y] = cA[y] * 0.3;
        hC[z] = cA[z] * 0.3;
      }

      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate    = true;
      haloGeo.attributes.position.needsUpdate = true;
      haloGeo.attributes.color.needsUpdate    = true;

      const rotY = st === "thinking" ? 0.014 : st === "listening" ? 0.003 : 0.0022;
      points.rotation.y += rotY;
      halo.rotation.y    = points.rotation.y;
      if (st === "thinking") {
        points.rotation.x += 0.005;
        halo.rotation.x    = points.rotation.x;
      } else {
        points.rotation.x += (0 - points.rotation.x) * 0.03;
        halo.rotation.x    = points.rotation.x;
      }

      if (st === "alert") {
        const pulse = 1 + Math.sin(t * 9) * 0.07;
        points.scale.setScalar(pulse);
        halo.scale.setScalar(pulse);
      } else {
        const s = points.scale.x;
        points.scale.setScalar(s + (1 - s) * 0.08);
        halo.scale.setScalar(points.scale.x);
      }

      renderer.render(scene, camera);
    }
    animate();

    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      geo.dispose(); haloGeo.dispose();
      mat.dispose(); haloMat.dispose();
      sprite.dispose();
    };
  }, []);

  // ── WebSocket + demo cycle ─────────────────────────────────────────────
  useEffect(() => {
    function runDemo() {
      const step = DEMO[demoIdx.current % DEMO.length];
      handleMsg({ state: step.state, text: step.text });
      demoIdx.current++;
      demoRef.current = setTimeout(runDemo, step.dur);
    }

    function connectWS() {
      if (wsRef.current?.readyState === WebSocket.OPEN) return;
      const ws = new WebSocket(WS_STATE);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        reconnectMs.current = 800;
        if (demoRef.current) { clearTimeout(demoRef.current); demoRef.current = null; }
        handleMsg({ state: "idle" });
      };
      ws.onmessage = e => {
        if (typeof e.data !== "string" || e.data === "pong") return;
        try { handleMsg(JSON.parse(e.data)); } catch {}
      };
      ws.onerror = () => setConnected(false);
      ws.onclose = () => {
        setConnected(false);
        const d = Math.min(reconnectMs.current, 12_000);
        reconnectMs.current = d * 2;
        setTimeout(connectWS, d);
      };
    }

    connectWS();

    const kickDemo = setTimeout(() => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) runDemo();
    }, 1500);

    const ping = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send("ping");
    }, 15_000);

    return () => {
      clearInterval(ping);
      clearTimeout(kickDemo);
      if (ttlRef.current)  clearTimeout(ttlRef.current);
      if (demoRef.current) clearTimeout(demoRef.current);
      wsRef.current?.close();
    };
  }, [handleMsg]);

  // ── Render ─────────────────────────────────────────────────────────────

  const displayText = curText.length > 120 ? curText.slice(0, 117) + "…" : curText;
  const isAlert     = curState === "alert";

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300..800&display=swap');
        *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
        html, body { height:100%; background:#0D0906; overflow:hidden; touch-action:none; }
        @keyframes textIn {
          from { opacity:0; transform:translateY(16px) scale(0.98); }
          to   { opacity:1; transform:translateY(0)    scale(1); }
        }
        /* Two fades: idle mark stays ghostly (0.28); live state labels fade in to fully legible (1). */
        @keyframes idleIn  { from { opacity:0; } to { opacity:0.28; } }
        @keyframes labelIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
      `}</style>

      <div style={{
        position: "fixed", inset: 0,
        background: "#0D0906",
        fontFamily: "'Fraunces', Georgia, serif",
        WebkitFontSmoothing: "antialiased",
        userSelect: "none",
      }}>
        {/* Particle canvas */}
        <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />

        {/* Warm vignette — lighter at the bottom so state labels stay legible. */}
        <div aria-hidden style={{
          position: "absolute", inset: 0, pointerEvents: "none",
          background: "radial-gradient(ellipse at center, transparent 50%, rgba(13,9,6,0.48) 100%)",
        }} />

        {/* Text overlay — answer / alert take the stage */}
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          padding: "0 44px",
          pointerEvents: "none",
        }}>
          {textVis && displayText && (
            <p style={{
              fontFamily: "'Fraunces', Georgia, serif",
              fontSize: "clamp(1.55rem, 6.5vw, 2.1rem)",
              fontWeight: 380,
              fontVariationSettings: '"opsz" 144, "SOFT" 100',
              fontStyle: isAlert ? "normal" : "italic",
              lineHeight: 1.4,
              textAlign: "center",
              color: isAlert ? "#E8A894" : "#F0E4D1",
              letterSpacing: "-0.012em",
              maxWidth: 420,
              animation: "textIn 0.5s cubic-bezier(0.16,1,0.3,1) forwards",
              textShadow: isAlert
                ? "0 0 48px rgba(198,101,72,0.55)"
                : "0 0 36px rgba(240,228,209,0.28)",
            }}>
              {isAlert && (
                <span aria-hidden style={{
                  display: "block",
                  fontSize: "0.62rem",
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                  color: "#C66548",
                  marginBottom: 14,
                  fontStyle: "normal",
                  opacity: 0.85,
                  fontWeight: 500,
                }}>
                  a gentle nudge
                </span>
              )}
              {!isAlert && (
                <span aria-hidden style={{
                  color: "rgba(203,139,83,0.55)",
                  fontSize: "1.6em",
                  verticalAlign: "-0.2em",
                  marginRight: "0.1em",
                }}>&ldquo;</span>
              )}
              {displayText}
              {!isAlert && (
                <span aria-hidden style={{
                  color: "rgba(203,139,83,0.55)",
                  fontSize: "1.6em",
                  verticalAlign: "-0.3em",
                  marginLeft: "0.08em",
                }}>&rdquo;</span>
              )}
            </p>
          )}

          {/* Idle hint — ghostly wordmark, uses the faint idleIn fade */}
          {curState === "idle" && (
            <p style={{
              position: "absolute",
              bottom: "17%",
              fontFamily: "'Fraunces', Georgia, serif",
              fontStyle: "italic",
              fontSize: "0.82rem",
              fontWeight: 300,
              color: "rgba(240,228,209,0.34)",
              letterSpacing: "0.22em",
              animation: "idleIn 1.2s ease forwards",
            }}>
              Recall · watching
            </p>
          )}

          {/* Transient state label — fully legible. */}
          {(curState === "listening" || curState === "thinking") && (
            <p style={{
              position: "absolute",
              bottom: "20%",
              fontFamily: "'Fraunces', Georgia, serif",
              fontStyle: "italic",
              fontSize: "1.15rem",
              fontWeight: 420,
              color: curState === "listening" ? "#C8DDB1" : "#E3B382",
              letterSpacing: "0.08em",
              animation: "labelIn 0.45s cubic-bezier(0.16,1,0.3,1) forwards",
              textShadow: curState === "listening"
                ? "0 0 28px rgba(155,173,130,0.55), 0 2px 18px rgba(13,9,6,0.8)"
                : "0 0 28px rgba(203,139,83,0.55), 0 2px 18px rgba(13,9,6,0.8)",
            }}>
              {curState === "listening" ? "listening —" : "remembering…"}
            </p>
          )}
        </div>

        {/* Connection dot — bottom center, barely there */}
        <div aria-hidden style={{
          position: "absolute", bottom: 22, left: "50%",
          transform: "translateX(-50%)",
          display: "flex", alignItems: "center", gap: 6,
          opacity: 0.22,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: "50%",
            background: connected ? "#9BAD82" : "#5A4A3B",
            boxShadow: connected ? "0 0 8px #9BAD82" : "none",
          }} />
          <span style={{
            fontFamily: "'Fraunces', Georgia, serif",
            fontStyle: "italic",
            fontSize: "0.62rem",
            color: "#F0E4D1",
            letterSpacing: "0.14em",
          }}>
            {connected ? "live" : "demo"}
          </span>
        </div>
      </div>
    </>
  );
}
