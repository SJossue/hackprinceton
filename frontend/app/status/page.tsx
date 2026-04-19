"use client";

/**
 * /status — Ambient "glass pane" display
 * Silent, output-only. Connects to ws://<pi>:8000/ws/state (CONTRACTS.md §3e).
 * Falls back to an auto-demo cycle when the Pi is unreachable.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";

// ── Config ────────────────────────────────────────────────────────────────────

const API_BASE   = (process.env.NEXT_PUBLIC_REWIND_API ?? "http://localhost:8000").replace(/\/$/, "");
const WS_STATE   = API_BASE.replace(/^http/, "ws") + "/ws/state";
const N          = 900;   // particle count
const ANSWER_TTL = 15_000;
const ALERT_TTL  = 10_000;

// ── Types ─────────────────────────────────────────────────────────────────────

type RState  = "idle" | "listening" | "thinking" | "answer" | "alert";
type StateMsg = { state: RState; text?: string };

// ── Demo cycle ────────────────────────────────────────────────────────────────

const DEMO: { state: RState; text?: string; dur: number }[] = [
  { state: "idle",      dur: 4500 },
  { state: "listening", dur: 2400 },
  { state: "thinking",  dur: 2200 },
  { state: "answer",    text: "Your pill bottle was picked up at 8:02 AM — about 4 hours ago.", dur: 8500 },
  { state: "idle",      dur: 3500 },
  { state: "listening", dur: 2000 },
  { state: "thinking",  dur: 2400 },
  { state: "answer",    text: "Your keys were placed on the counter near the sink at 3:14 PM.", dur: 8500 },
  { state: "alert",     text: "Evening dose 6 hours overdue", dur: 6000 },
];

// ── Particle helpers ──────────────────────────────────────────────────────────

// RGB 0-1 per state
const COLORS: Record<RState, [number, number, number]> = {
  idle:      [0.063, 0.725, 0.506],  // #10b981
  listening: [0.204, 0.827, 0.600],  // #34d399
  thinking:  [0.651, 0.961, 0.851],  // #a7f3d0
  answer:    [0.94,  0.94,  0.97 ],  // near-white
  alert:     [0.937, 0.267, 0.267],  // #ef4444
};

function computeTargets(state: RState): Float32Array {
  const a = new Float32Array(N * 3);
  switch (state) {

    case "idle": {
      // Uniform sphere
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
      // Concentric rings in XZ plane
      const RINGS = 8;
      for (let i = 0; i < N; i++) {
        const ring   = i % RINGS;
        const radius = 0.3 + ring * 0.36;
        const perRing = Math.floor(N / RINGS);
        const angle  = ((i % perRing) / perRing) * Math.PI * 2 + (Math.random() - 0.5) * 0.1;
        const jitter = (Math.random() - 0.5) * 0.07;
        a[i*3]   = Math.cos(angle) * (radius + jitter);
        a[i*3+1] = (Math.random() - 0.5) * 0.1;
        a[i*3+2] = Math.sin(angle) * (radius + jitter);
      }
      break;
    }

    case "thinking": {
      // Double helix
      for (let i = 0; i < N; i++) {
        const strand = i % 2;
        const t     = (Math.floor(i / 2)) / (N / 2);
        const turns = 5;
        const angle = t * Math.PI * 2 * turns + strand * Math.PI;
        const r     = 0.35 + t * 1.85;
        a[i*3]   = Math.cos(angle) * r;
        a[i*3+1] = (t - 0.5) * 3.8;
        a[i*3+2] = Math.sin(angle) * r;
      }
      break;
    }

    case "answer": {
      // Particles drift far out — text takes center stage
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
      // Tight pulsing cluster
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

// Soft radial glow sprite (drawn once onto a canvas)
function makeSprite(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0,    "rgba(255,255,255,1)");
  g.addColorStop(0.3,  "rgba(255,255,255,0.75)");
  g.addColorStop(0.7,  "rgba(255,255,255,0.2)");
  g.addColorStop(1,    "rgba(255,255,255,0)");
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

  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const stateRef     = useRef<RState>("idle");
  const targetsRef   = useRef<Float32Array>(computeTargets("idle"));
  const wsRef        = useRef<WebSocket | null>(null);
  const ttlRef       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const demoRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const demoIdx      = useRef(0);
  const reconnectMs  = useRef(800);

  // ── State transitions ───────────────────────────────────────────────────

  const handleMsg = useCallback((msg: StateMsg) => {
    if (ttlRef.current) clearTimeout(ttlRef.current);
    setCurState(msg.state);
    setCurText(msg.text ?? "");
  }, []);

  // Auto-return to idle for transient states
  useEffect(() => {
    if (curState === "answer") {
      ttlRef.current = setTimeout(() => { setCurState("idle"); setCurText(""); }, ANSWER_TTL);
    }
    if (curState === "alert") {
      ttlRef.current = setTimeout(() => { setCurState("idle"); setCurText(""); }, ALERT_TTL);
    }
    setTextVis(curState === "answer" || curState === "alert");
    stateRef.current    = curState;
    targetsRef.current  = computeTargets(curState);
    return () => { if (ttlRef.current) clearTimeout(ttlRef.current); };
  }, [curState]);

  // ── Three.js scene ──────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 1);

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.z = 5.5;

    // Subtle fog for depth
    scene.fog = new THREE.FogExp2(0x000000, 0.06);

    const sprite = makeSprite();

    // Particle geometry
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

    // Second, slightly larger, dimmer layer for glow halo
    const haloPosArr = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) haloPosArr[i] = pos[i];
    const haloColArr = new Float32Array(N * 3);
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
      transparent: true, opacity: 0.15,
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

      // Lerp speed per state
      const lerpSpeed = st === "thinking" ? 0.065 : st === "alert" ? 0.055 : st === "answer" ? 0.022 : 0.02;

      const tc = COLORS[st];

      for (let i = 0; i < N; i++) {
        const x = i*3, y = x+1, z = x+2;

        // Lerp toward target
        pA[x] += (tg[x] - pA[x]) * lerpSpeed;
        pA[y] += (tg[y] - pA[y]) * lerpSpeed;
        pA[z] += (tg[z] - pA[z]) * lerpSpeed;

        // State perturbations
        if (st === "listening") {
          // Ripple rings outward
          const ring = i % 8;
          const wave = Math.sin(t * 3.5 - ring * 0.55) * 0.055;
          pA[x] += pA[x] * wave * 0.04;
          pA[z] += pA[z] * wave * 0.04;
        }
        if (st === "alert") {
          // Rapid jitter
          pA[x] += (Math.random() - 0.5) * 0.05;
          pA[y] += (Math.random() - 0.5) * 0.05;
          pA[z] += (Math.random() - 0.5) * 0.05;
        }
        if (st === "idle") {
          // Gentle breathing — uniform scale oscillation
          const breath = 1 + Math.sin(t * 0.8) * 0.015;
          pA[x] *= breath;
          pA[y] *= breath;
          pA[z] *= breath;
        }

        // Color lerp
        cA[x] += (tc[0] - cA[x]) * 0.04;
        cA[y] += (tc[1] - cA[y]) * 0.04;
        cA[z] += (tc[2] - cA[z]) * 0.04;

        // Mirror to halo with dimming
        hP[x] = pA[x]; hP[y] = pA[y]; hP[z] = pA[z];
        hC[x] = cA[x] * 0.3;
        hC[y] = cA[y] * 0.3;
        hC[z] = cA[z] * 0.3;
      }

      geo.attributes.position.needsUpdate  = true;
      geo.attributes.color.needsUpdate     = true;
      haloGeo.attributes.position.needsUpdate = true;
      haloGeo.attributes.color.needsUpdate    = true;

      // Rotation
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

      // Alert pulse scale
      if (st === "alert") {
        const pulse = 1 + Math.sin(t * 9) * 0.07;
        points.scale.setScalar(pulse);
        halo.scale.setScalar(pulse);
      } else {
        const s = points.scale.x;
        const target = 1.0;
        points.scale.setScalar(s + (target - s) * 0.08);
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

  // ── WebSocket + demo cycle ──────────────────────────────────────────────

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

  // ── Render ──────────────────────────────────────────────────────────────

  const displayText = curText.length > 120 ? curText.slice(0, 117) + "…" : curText;
  const isAlert     = curState === "alert";

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@300;400;500;600&display=swap');
        *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
        html, body { height:100%; background:#000; overflow:hidden; touch-action:none; }
        @keyframes textIn {
          from { opacity:0; transform:translateY(14px) scale(0.98); }
          to   { opacity:1; transform:translateY(0)    scale(1); }
        }
        @keyframes subIn {
          from { opacity:0; }
          to   { opacity:1; }
        }
      `}</style>

      <div style={{
        position: "fixed", inset: 0,
        background: "#000",
        fontFamily: "'Syne', ui-sans-serif, sans-serif",
        WebkitFontSmoothing: "antialiased",
        userSelect: "none",
      }}>
        {/* Three.js canvas — fills the whole screen */}
        <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />

        {/* Vignette overlay — darkens edges for that glass-panel feel */}
        <div style={{
          position: "absolute", inset: 0, pointerEvents: "none",
          background: "radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.65) 100%)",
        }} />

        {/* Text overlay — only shows on answer / alert */}
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          padding: "0 44px",
          pointerEvents: "none",
        }}>
          {textVis && displayText && (
            <p style={{
              fontSize: "clamp(1.55rem, 6.5vw, 2rem)",
              fontWeight: 400,
              lineHeight: 1.5,
              textAlign: "center",
              color: isAlert ? "#fca5a5" : "#ffffff",
              letterSpacing: "-0.01em",
              maxWidth: 380,
              animation: "textIn 0.45s cubic-bezier(0.16,1,0.3,1) forwards",
              textShadow: isAlert
                ? "0 0 40px rgba(239,68,68,0.6)"
                : "0 0 30px rgba(255,255,255,0.25)",
            }}>
              {displayText}
            </p>
          )}

          {/* Idle hint — barely visible */}
          {curState === "idle" && (
            <p style={{
              position: "absolute",
              bottom: "18%",
              fontSize: "0.7rem",
              fontWeight: 300,
              color: "rgba(255,255,255,0.18)",
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              animation: "subIn 1.2s ease forwards",
            }}>
              Rewind · watching
            </p>
          )}

          {/* State label — listening / thinking */}
          {(curState === "listening" || curState === "thinking") && (
            <p style={{
              position: "absolute",
              bottom: "22%",
              fontSize: "0.85rem",
              fontWeight: 400,
              color: "rgba(52,211,153,0.75)",
              letterSpacing: "0.14em",
              animation: "subIn 0.4s ease forwards",
            }}>
              {curState === "listening" ? "listening" : "thinking…"}
            </p>
          )}
        </div>

        {/* Connection dot — bottom center, barely there */}
        <div style={{
          position: "absolute", bottom: 22, left: "50%",
          transform: "translateX(-50%)",
          display: "flex", alignItems: "center", gap: 5,
          opacity: 0.18,
        }}>
          <div style={{
            width: 5, height: 5, borderRadius: "50%",
            background: connected ? "#10b981" : "#555",
            boxShadow: connected ? "0 0 6px #10b981" : "none",
          }} />
          <span style={{ fontSize: "0.58rem", color: "#fff", letterSpacing: "0.1em", fontFamily: "monospace" }}>
            {connected ? "live" : "demo"}
          </span>
        </div>
      </div>
    </>
  );
}
