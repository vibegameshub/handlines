import { useState, useRef, useCallback, useEffect } from "react";
import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const API_URL = import.meta.env.VITE_API_URL || "https://handlines-production.up.railway.app";

type Stage = "idle" | "camera" | "countdown" | "analyzing" | "result";

const PALM_BASE = [0, 1, 5, 9, 13, 17];

// Particle system for hand effects
type Particle = { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; color: string; size: number };
const particles: Particle[] = [];

function spawnParticles(x: number, y: number, color: string, count: number) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 1.5 + 0.5;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      maxLife: Math.random() * 40 + 20,
      color,
      size: Math.random() * 2.5 + 1,
    });
  }
}

function updateAndDrawParticles(ctx: CanvasRenderingContext2D) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vx *= 0.97;
    p.vy *= 0.97;
    p.life -= 1 / p.maxLife;

    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }

    ctx.save();
    ctx.globalAlpha = p.life * 0.8;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.restore();
  }
}

export default function App() {
  const [stage, setStage] = useState<Stage>("idle");
  const [imageData, setImageData] = useState<string | null>(null);
  const [reading, setReading] = useState("");
  const [error, setError] = useState("");
  const [count, setCount] = useState(0);
  const [statusText, setStatusText] = useState("");
  const [cameraReady, setCameraReady] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const handLandmarkerRef = useRef<HandLandmarker | null>(null);
  const animFrameRef = useRef<number>(0);
  const palmStableRef = useRef(0);
  const countdownRef = useRef<NodeJS.Timeout | null>(null);
  const stageRef = useRef<Stage>("idle");
  const lastVideoTimeRef = useRef(-1);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediapipeLoadingRef = useRef(false);

  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  const stopCamera = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = 0;
    }
    if (countdownRef.current) {
      clearTimeout(countdownRef.current);
      countdownRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    palmStableRef.current = 0;
    setCameraReady(false);
    lastVideoTimeRef.current = -1;
  }, []);

  useEffect(() => {
    return () => {
      stopCamera();
      if (handLandmarkerRef.current) {
        handLandmarkerRef.current.close();
        handLandmarkerRef.current = null;
      }
    };
  }, [stopCamera]);

  // Load MediaPipe in background (non-blocking)
  const loadMediaPipe = async () => {
    if (handLandmarkerRef.current || mediapipeLoadingRef.current) return;
    mediapipeLoadingRef.current = true;
    try {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm"
      );
      handLandmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
          delegate: "GPU",
        },
        numHands: 1,
        runningMode: "VIDEO",
      });
      console.log("MediaPipe loaded");
    } catch (err) {
      console.warn("MediaPipe failed to load, hand detection disabled:", err);
    }
    mediapipeLoadingRef.current = false;
  };

  const startCamera = async () => {
    setError("");
    setStage("camera");
    setStatusText("카메라 시작 중...");

    try {
      // Start camera FIRST — show video immediately
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 960 } },
      });
      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) {
        throw new Error("비디오 요소를 찾을 수 없습니다.");
      }

      video.srcObject = stream;

      // Wait for video to actually start playing
      await new Promise<void>((resolve, reject) => {
        const onPlaying = () => {
          video.removeEventListener("playing", onPlaying);
          video.removeEventListener("error", onError);
          resolve();
        };
        const onError = () => {
          video.removeEventListener("playing", onPlaying);
          video.removeEventListener("error", onError);
          reject(new Error("비디오 재생 실패"));
        };
        video.addEventListener("playing", onPlaying);
        video.addEventListener("error", onError);
        video.play().catch(reject);
      });

      setCameraReady(true);
      setStatusText("손바닥을 카메라에 보여주세요");

      // Load MediaPipe in background — camera works without it
      loadMediaPipe();

      // Start render/detect loop
      startDetectLoop();
    } catch (err) {
      console.error("Camera error:", err);
      stopCamera();
      setError("카메라에 접근할 수 없습니다. 파일 업로드를 이용해주세요.");
      setStage("idle");
    }
  };

  const startDetectLoop = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const ctx = canvas.getContext("2d")!;

    const loop = () => {
      if (!streamRef.current || !videoRef.current) return;

      // Update canvas size to match video
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }
      }

      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // Try hand detection if MediaPipe is loaded
      const handLandmarker = handLandmarkerRef.current;
      if (handLandmarker && video.readyState >= 2 && video.currentTime !== lastVideoTimeRef.current) {
        lastVideoTimeRef.current = video.currentTime;

        try {
          const results = handLandmarker.detectForVideo(video, performance.now());

          if (results.landmarks && results.landmarks.length > 0) {
            const landmarks = results.landmarks[0];
            drawHandGraphics(ctx, landmarks, w, h);

            const allVisible = PALM_BASE.every(
              (i) =>
                landmarks[i].x > 0.05 &&
                landmarks[i].x < 0.95 &&
                landmarks[i].y > 0.05 &&
                landmarks[i].y < 0.95
            );
            const palmWidth = Math.abs(landmarks[5].x - landmarks[17].x);
            const palmBigEnough = palmWidth > 0.15;

            if (allVisible && palmBigEnough) {
              palmStableRef.current++;
              if (stageRef.current === "camera") {
                setStatusText("손바닥 인식됨! 그대로 유지하세요...");
              }
              if (palmStableRef.current > 30 && stageRef.current === "camera") {
                startCountdown();
              }
            } else {
              palmStableRef.current = Math.max(0, palmStableRef.current - 2);
              if (stageRef.current === "camera") {
                setStatusText("손바닥을 카메라에 보여주세요");
              }
            }
          } else {
            palmStableRef.current = Math.max(0, palmStableRef.current - 5);
            if (stageRef.current === "camera") {
              setStatusText("손바닥을 카메라에 보여주세요");
            }
          }
        } catch {
          // Detection error — continue without crashing
        }
      }

      // Scan effect
      if (stageRef.current === "camera") {
        drawScanEffect(ctx, w, h);
      }

      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);
  };

  const drawHandGraphics = (
    ctx: CanvasRenderingContext2D,
    landmarks: { x: number; y: number }[],
    w: number,
    h: number
  ) => {
    const lm = landmarks.map((p) => ({ x: p.x * w, y: p.y * h }));
    const t = Date.now() / 1000;
    const pulse = Math.sin(t * 3) * 0.3 + 0.7; // 0.4 ~ 1.0 pulsing
    const stability = Math.min(palmStableRef.current / 30, 1); // 0 ~ 1

    // --- Energy aura around palm ---
    const palmCenter = {
      x: PALM_BASE.reduce((s, i) => s + lm[i].x, 0) / PALM_BASE.length,
      y: PALM_BASE.reduce((s, i) => s + lm[i].y, 0) / PALM_BASE.length,
    };
    const palmRadius = Math.abs(lm[5].x - lm[17].x) * 0.8;

    // Outer aura rings
    for (let r = 0; r < 3; r++) {
      const radius = palmRadius * (1.3 + r * 0.25) + Math.sin(t * 2 + r) * 8;
      const alpha = (0.12 - r * 0.03) * pulse;
      ctx.beginPath();
      ctx.arc(palmCenter.x, palmCenter.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(124, 58, 237, ${alpha})`;
      ctx.lineWidth = 2;
      ctx.shadowColor = "#7c3aed";
      ctx.shadowBlur = 20;
      ctx.stroke();
    }

    // Rotating energy ring
    ctx.save();
    ctx.translate(palmCenter.x, palmCenter.y);
    ctx.rotate(t * 0.5);
    const ringRadius = palmRadius * 1.1;
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const dotSize = (Math.sin(t * 4 + i) * 0.5 + 1) * 2;
      ctx.beginPath();
      ctx.arc(Math.cos(angle) * ringRadius, Math.sin(angle) * ringRadius, dotSize, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(212, 168, 67, ${0.3 + Math.sin(t * 3 + i) * 0.3})`;
      ctx.shadowColor = "#d4a843";
      ctx.shadowBlur = 10;
      ctx.fill();
    }
    ctx.restore();

    // --- Palm outline with glow ---
    ctx.shadowColor = "#d4a843";
    ctx.shadowBlur = 15 * pulse;
    ctx.beginPath();
    ctx.strokeStyle = `rgba(212, 168, 67, ${0.4 + stability * 0.3})`;
    ctx.lineWidth = 2;
    const palmPoints = PALM_BASE.map((i) => lm[i]);
    ctx.moveTo(palmPoints[0].x, palmPoints[0].y);
    for (let i = 1; i < palmPoints.length; i++) ctx.lineTo(palmPoints[i].x, palmPoints[i].y);
    ctx.closePath();
    ctx.stroke();

    // --- Palm lines with animated flow ---
    const lineWidth = 2.5 + pulse * 0.5;

    // Heart line - pink/red
    const heartPts = [lm[17], lm[13], lm[9], lm[5]];
    drawAnimatedCurve(ctx, heartPts, "#ff6b9d", lineWidth, t);
    // Head line - blue
    const headPts = [midpoint(lm[0], lm[5]), midpoint(lm[0], lm[9]), midpoint(lm[0], lm[13]), midpoint(lm[0], lm[17])];
    drawAnimatedCurve(ctx, headPts, "#64b5f6", lineWidth, t + 1);
    // Life line - green
    const lifePts = [midpoint(lm[1], lm[5]), lerp(lm[1], lm[0], 0.4), lerp(lm[0], lm[1], 0.7), lm[0]];
    drawAnimatedCurve(ctx, lifePts, "#66bb6a", lineWidth, t + 2);
    // Fate line - purple
    const fatePts = [lm[0], midpoint(lm[0], lm[9]), lm[9]];
    drawAnimatedCurve(ctx, fatePts, "#ce93d8", lineWidth - 0.5, t + 3);

    // --- Spawn particles along lines occasionally ---
    if (Math.random() < 0.3) {
      const allLines = [heartPts, headPts, lifePts, fatePts];
      const colors = ["#ff6b9d", "#64b5f6", "#66bb6a", "#ce93d8"];
      const li = Math.floor(Math.random() * allLines.length);
      const pi = Math.floor(Math.random() * allLines[li].length);
      spawnParticles(allLines[li][pi].x, allLines[li][pi].y, colors[li], 2);
    }

    ctx.shadowBlur = 0;

    // --- Finger connections with energy flow ---
    const fingers = [[1,2,3,4],[5,6,7,8],[9,10,11,12],[13,14,15,16],[17,18,19,20]];
    for (let fi = 0; fi < fingers.length; fi++) {
      const f = fingers[fi];
      const flowT = (t * 2 + fi * 0.5) % 1;

      // Base line
      ctx.beginPath();
      ctx.strokeStyle = `rgba(212, 168, 67, ${0.2 + stability * 0.15})`;
      ctx.lineWidth = 1.5;
      ctx.moveTo(lm[f[0]].x, lm[f[0]].y);
      for (let i = 1; i < f.length; i++) ctx.lineTo(lm[f[i]].x, lm[f[i]].y);
      ctx.stroke();

      // Energy dot flowing along finger
      const segIdx = Math.floor(flowT * (f.length - 1));
      const segT = (flowT * (f.length - 1)) - segIdx;
      if (segIdx < f.length - 1) {
        const fx = lm[f[segIdx]].x + (lm[f[segIdx + 1]].x - lm[f[segIdx]].x) * segT;
        const fy = lm[f[segIdx]].y + (lm[f[segIdx + 1]].y - lm[f[segIdx]].y) * segT;
        ctx.beginPath();
        ctx.arc(fx, fy, 3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(240, 208, 120, ${0.6 + pulse * 0.4})`;
        ctx.shadowColor = "#f0d078";
        ctx.shadowBlur = 12;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    // --- Landmark dots with pulsing glow ---
    for (let i = 0; i < lm.length; i++) {
      const isBase = PALM_BASE.includes(i);
      const isTip = [4, 8, 12, 16, 20].includes(i);
      const dotPulse = Math.sin(t * 4 + i * 0.5) * 0.5 + 0.5;
      const baseSize = isBase ? 4 : isTip ? 3.5 : 2.5;
      const size = baseSize + dotPulse * (isBase ? 2 : 1);

      ctx.beginPath();
      ctx.arc(lm[i].x, lm[i].y, size, 0, Math.PI * 2);

      if (isBase) {
        ctx.fillStyle = `rgba(240, 208, 120, ${0.7 + dotPulse * 0.3})`;
        ctx.shadowColor = "#f0d078";
        ctx.shadowBlur = 15;
      } else if (isTip) {
        ctx.fillStyle = `rgba(124, 58, 237, ${0.6 + dotPulse * 0.4})`;
        ctx.shadowColor = "#7c3aed";
        ctx.shadowBlur = 12;
        // Spawn particles from fingertips
        if (Math.random() < 0.1) spawnParticles(lm[i].x, lm[i].y, "#7c3aed", 1);
      } else {
        ctx.fillStyle = `rgba(200, 180, 220, ${0.4 + dotPulse * 0.2})`;
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // --- Update and draw particles ---
    updateAndDrawParticles(ctx);
  };

  const drawScanEffect = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const t = (Date.now() % 3000) / 3000;
    const y = t * h;
    const gradient = ctx.createLinearGradient(0, y - 30, 0, y + 30);
    gradient.addColorStop(0, "rgba(124, 58, 237, 0)");
    gradient.addColorStop(0.5, "rgba(124, 58, 237, 0.15)");
    gradient.addColorStop(1, "rgba(124, 58, 237, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, y - 30, w, 60);
  };

  const startCountdown = () => {
    setStage("countdown");
    setCount(3);
    setStatusText("잠시만 유지하세요!");

    let remaining = 3;
    const tick = () => {
      remaining--;
      if (remaining > 0) {
        setCount(remaining);
        countdownRef.current = setTimeout(tick, 1000);
      } else {
        setCount(0);
        captureAndAnalyze();
      }
    };
    countdownRef.current = setTimeout(tick, 1000);
  };

  const captureAndAnalyze = () => {
    const video = videoRef.current;
    const captureCanvas = captureCanvasRef.current;
    if (!video || !captureCanvas) return;

    captureCanvas.width = video.videoWidth;
    captureCanvas.height = video.videoHeight;
    const ctx = captureCanvas.getContext("2d")!;
    ctx.drawImage(video, 0, 0);
    const data = captureCanvas.toDataURL("image/jpeg", 0.85);

    stopCamera();
    setImageData(data);
    setStage("analyzing");
    setStatusText("손금을 분석하는 중...");
    analyze(data);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    const reader = new FileReader();
    reader.onload = () => {
      const data = reader.result as string;
      stopCamera();
      setImageData(data);
      setStage("analyzing");
      setStatusText("손금을 분석하는 중...");
      analyze(data);
    };
    reader.readAsDataURL(file);
  };

  const analyze = async (image: string) => {
    try {
      const res = await fetch(`${API_URL}/api/read-palm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "분석에 실패했습니다.");
      setReading(data.reading);
      setStage("result");
    } catch (err) {
      setError(err instanceof Error ? err.message : "오류가 발생했습니다.");
      setStage("idle");
    }
  };

  const reset = () => {
    stopCamera();
    setStage("idle");
    setImageData(null);
    setReading("");
    setError("");
    setCount(0);
    setStatusText("");
    palmStableRef.current = 0;
  };

  const isCamera = stage === "camera" || stage === "countdown";

  return (
    <main className="container">
      <header className="header">
        <h1>AI 손금 리더</h1>
        <p>AI가 당신의 손금을 분석합니다</p>
      </header>

      <div className={`capture-area${imageData && !isCamera ? " has-image" : ""}${isCamera ? " camera-active" : ""}`}>
        {/* Video — always mounted, visibility toggled via CSS */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={isCamera ? "visible" : "hidden"}
        />
        <canvas
          ref={canvasRef}
          className={`overlay-canvas ${isCamera ? "visible" : "hidden"}`}
        />

        {imageData && !isCamera && (
          <img src={imageData} alt="손바닥 사진" />
        )}

        {stage === "idle" && !imageData && (
          <>
            <div className="hand-icon">&#x270B;</div>
            <p className="capture-hint">
              손바닥이 잘 보이도록<br />밝은 곳에서 촬영해주세요
            </p>
          </>
        )}

        {stage === "countdown" && count > 0 && (
          <div className="countdown-overlay">
            <div className="countdown-number">{count}</div>
          </div>
        )}

        {stage === "analyzing" && (
          <div className="analyzing-overlay">
            <div className="crystal-ball">&#x1F52E;</div>
            <p>손금을 분석하는 중...</p>
          </div>
        )}
      </div>

      <canvas ref={captureCanvasRef} style={{ display: "none" }} />

      {statusText && isCamera && (
        <p className="status-text">{statusText}</p>
      )}

      {error && <p className="error">{error}</p>}

      {stage === "idle" && (
        <div className="buttons">
          <button className="btn btn-primary" onClick={startCamera}>
            &#x1F4F7; 카메라 촬영
          </button>
          <button className="btn btn-secondary" onClick={() => fileInputRef.current?.click()}>
            &#x1F4C1; 사진 업로드
          </button>
          <input
            ref={fileInputRef}
            className="file-input"
            type="file"
            accept="image/*"
            onChange={handleFileUpload}
          />
        </div>
      )}

      {isCamera && (
        <div className="buttons">
          <button className="btn btn-secondary" onClick={reset}>
            &#x2715; 취소
          </button>
        </div>
      )}

      {stage === "result" && (
        <>
          <div className="result">
            <h2>&#x2728; 손금 분석 결과 &#x2728;</h2>
            <div
              className="result-text"
              dangerouslySetInnerHTML={{
                __html: reading
                  .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
                  .replace(/\n/g, "<br/>"),
              }}
            />
          </div>
          <button className="btn btn-primary btn-full" onClick={reset}>
            &#x1F504; 다시 보기
          </button>
        </>
      )}
    </main>
  );
}

function midpoint(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function lerp(a: { x: number; y: number }, b: { x: number; y: number }, t: number) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function drawAnimatedCurve(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  color: string,
  width: number,
  time: number
) {
  if (points.length < 2) return;
  const glow = Math.sin(time * 3) * 0.3 + 0.7;

  // Outer glow layer
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width + 4;
  ctx.lineCap = "round";
  ctx.globalAlpha = 0.15 * glow;
  ctx.shadowColor = color;
  ctx.shadowBlur = 25;
  traceCurve(ctx, points);
  ctx.stroke();

  // Main line
  ctx.globalAlpha = 0.7 + glow * 0.3;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.shadowBlur = 12;
  traceCurve(ctx, points);
  ctx.stroke();

  // Inner bright core
  ctx.beginPath();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
  ctx.lineWidth = width * 0.4;
  ctx.shadowBlur = 0;
  traceCurve(ctx, points);
  ctx.stroke();

  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;

  // Animated energy dot traveling along the line
  const flowPos = (time * 0.8) % 1;
  const segCount = points.length - 1;
  const segIdx = Math.floor(flowPos * segCount);
  const segT = (flowPos * segCount) - segIdx;
  if (segIdx < segCount) {
    const dx = points[segIdx].x + (points[segIdx + 1].x - points[segIdx].x) * segT;
    const dy = points[segIdx].y + (points[segIdx + 1].y - points[segIdx].y) * segT;
    ctx.beginPath();
    ctx.arc(dx, dy, 4 + glow * 2, 0, Math.PI * 2);
    ctx.fillStyle = "white";
    ctx.shadowColor = color;
    ctx.shadowBlur = 20;
    ctx.globalAlpha = 0.8;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }
}

function traceCurve(ctx: CanvasRenderingContext2D, points: { x: number; y: number }[]) {
  ctx.moveTo(points[0].x, points[0].y);
  if (points.length === 2) {
    ctx.lineTo(points[1].x, points[1].y);
  } else {
    for (let i = 0; i < points.length - 1; i++) {
      const xc = (points[i].x + points[i + 1].x) / 2;
      const yc = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
  }
}
