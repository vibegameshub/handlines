import { useState, useRef, useCallback, useEffect } from "react";
import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const API_URL = import.meta.env.VITE_API_URL || "https://handlines-production.up.railway.app";

type Stage = "idle" | "camera" | "detected" | "countdown" | "analyzing" | "result";

// MediaPipe hand landmark indices
const PALM_BASE = [0, 1, 5, 9, 13, 17]; // wrist + finger bases

export default function App() {
  const [stage, setStage] = useState<Stage>("idle");
  const [imageData, setImageData] = useState<string | null>(null);
  const [reading, setReading] = useState("");
  const [error, setError] = useState("");
  const [count, setCount] = useState(0);
  const [statusText, setStatusText] = useState("");

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

  // Keep stageRef in sync
  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  const stopCamera = useCallback(() => {
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    if (countdownRef.current) clearTimeout(countdownRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    palmStableRef.current = 0;
  }, []);

  const cleanup = useCallback(() => {
    stopCamera();
    if (handLandmarkerRef.current) {
      handLandmarkerRef.current.close();
      handLandmarkerRef.current = null;
    }
  }, [stopCamera]);

  useEffect(() => () => cleanup(), [cleanup]);

  // Draw palm line graphics on canvas
  const drawHandGraphics = (
    ctx: CanvasRenderingContext2D,
    landmarks: { x: number; y: number }[],
    w: number,
    h: number
  ) => {
    const lm = landmarks.map((p) => ({ x: p.x * w, y: p.y * h }));

    // Glow effect
    ctx.shadowColor = "#d4a843";
    ctx.shadowBlur = 12;

    // Draw palm outline
    ctx.beginPath();
    ctx.strokeStyle = "rgba(212, 168, 67, 0.6)";
    ctx.lineWidth = 2;
    const palmPoints = PALM_BASE.map((i) => lm[i]);
    ctx.moveTo(palmPoints[0].x, palmPoints[0].y);
    for (let i = 1; i < palmPoints.length; i++) {
      ctx.lineTo(palmPoints[i].x, palmPoints[i].y);
    }
    ctx.closePath();
    ctx.stroke();

    // Heart line (below fingers, from pinky side to index side)
    drawCurve(ctx, [lm[17], lm[13], lm[9], lm[5]], "#ff6b9d", 2.5);

    // Head line (middle of palm)
    const headStart = midpoint(lm[0], lm[5]);
    const headMid1 = midpoint(lm[0], lm[9]);
    const headMid2 = midpoint(lm[0], lm[13]);
    const headEnd = midpoint(lm[0], lm[17]);
    drawCurve(ctx, [headStart, headMid1, headMid2, headEnd], "#64b5f6", 2.5);

    // Life line (curves around thumb)
    const lifeStart = midpoint(lm[1], lm[5]);
    const lifeMid1 = lerp(lm[1], lm[0], 0.4);
    const lifeMid2 = lerp(lm[0], lm[1], 0.7);
    drawCurve(ctx, [lifeStart, lifeMid1, lifeMid2, lm[0]], "#66bb6a", 2.5);

    // Fate line (wrist to middle finger base)
    const fateMid = midpoint(lm[0], lm[9]);
    drawCurve(ctx, [lm[0], fateMid, lm[9]], "#ce93d8", 2);

    ctx.shadowBlur = 0;

    // Draw landmark dots
    for (let i = 0; i < lm.length; i++) {
      ctx.beginPath();
      ctx.arc(lm[i].x, lm[i].y, 3, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(240, 208, 120, 0.8)";
      ctx.fill();
    }

    // Finger connections
    const fingers = [[1,2,3,4],[5,6,7,8],[9,10,11,12],[13,14,15,16],[17,18,19,20]];
    ctx.strokeStyle = "rgba(212, 168, 67, 0.3)";
    ctx.lineWidth = 1.5;
    ctx.shadowBlur = 0;
    for (const finger of fingers) {
      ctx.beginPath();
      ctx.moveTo(lm[finger[0]].x, lm[finger[0]].y);
      for (let i = 1; i < finger.length; i++) {
        ctx.lineTo(lm[finger[i]].x, lm[finger[i]].y);
      }
      ctx.stroke();
    }
  };

  // Scan line effect
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

  const initHandDetection = async () => {
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
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
  };

  const startCamera = async () => {
    setError("");
    setStage("camera");
    setStatusText("손바닥을 카메라에 보여주세요");

    try {
      if (!handLandmarkerRef.current) {
        setStatusText("AI 모델 로딩 중...");
        await initHandDetection();
        setStatusText("손바닥을 카메라에 보여주세요");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 960 } },
      });
      streamRef.current = stream;

      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();

      // Start detection loop
      detectLoop();
    } catch {
      setError("카메라에 접근할 수 없습니다.");
      setStage("idle");
    }
  };

  const detectLoop = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const handLandmarker = handLandmarkerRef.current;
    if (!video || !canvas || !handLandmarker) return;

    const ctx = canvas.getContext("2d")!;
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const w = canvas.width;
    const h = canvas.height;

    const loop = () => {
      if (!streamRef.current) return;

      ctx.clearRect(0, 0, w, h);

      // Detect hands
      if (video.readyState >= 2 && video.currentTime !== lastVideoTimeRef.current) {
        lastVideoTimeRef.current = video.currentTime;
        const results = handLandmarker.detectForVideo(video, performance.now());

        if (results.landmarks && results.landmarks.length > 0) {
          const landmarks = results.landmarks[0];
          drawHandGraphics(ctx, landmarks, w, h);

          // Check if palm is fully visible (all base landmarks in frame)
          const allVisible = PALM_BASE.every(
            (i) => landmarks[i].x > 0.05 && landmarks[i].x < 0.95 && landmarks[i].y > 0.05 && landmarks[i].y < 0.95
          );

          // Check palm size (should be big enough)
          const palmWidth = Math.abs(landmarks[5].x - landmarks[17].x);
          const palmBigEnough = palmWidth > 0.15;

          if (allVisible && palmBigEnough) {
            palmStableRef.current++;

            if (palmStableRef.current > 30 && stageRef.current === "camera") {
              // Palm stable for ~1 second, start countdown
              startCountdown();
            }
          } else {
            palmStableRef.current = Math.max(0, palmStableRef.current - 2);
          }
        } else {
          palmStableRef.current = Math.max(0, palmStableRef.current - 5);
          if (stageRef.current === "camera") {
            setStatusText("손바닥을 카메라에 보여주세요");
          }
        }
      }

      // Draw scan effect when detecting
      if (stageRef.current === "camera" || stageRef.current === "detected") {
        drawScanEffect(ctx, w, h);
      }

      animFrameRef.current = requestAnimationFrame(loop);
    };

    loop();
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

  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <main className="container">
      <header className="header">
        <h1>AI 손금 리더</h1>
        <p>AI가 당신의 손금을 분석합니다</p>
      </header>

      {/* Camera / Image Area */}
      <div className={`capture-area${imageData && stage !== "camera" ? " has-image" : ""}${stage === "camera" || stage === "detected" || stage === "countdown" ? " camera-active" : ""}`}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{
            display: stage === "camera" || stage === "detected" || stage === "countdown" ? "block" : "none",
          }}
        />
        <canvas
          ref={canvasRef}
          className="overlay-canvas"
          style={{
            display: stage === "camera" || stage === "detected" || stage === "countdown" ? "block" : "none",
          }}
        />

        {imageData && stage !== "camera" && stage !== "countdown" && (
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

        {/* Countdown overlay */}
        {stage === "countdown" && count > 0 && (
          <div className="countdown-overlay">
            <div className="countdown-number">{count}</div>
          </div>
        )}

        {/* Analyzing overlay */}
        {stage === "analyzing" && (
          <div className="analyzing-overlay">
            <div className="crystal-ball">&#x1F52E;</div>
            <p>손금을 분석하는 중...</p>
          </div>
        )}
      </div>

      <canvas ref={captureCanvasRef} style={{ display: "none" }} />

      {/* Status text */}
      {statusText && stage !== "result" && stage !== "idle" && stage !== "analyzing" && (
        <p className="status-text">{statusText}</p>
      )}

      {/* Buttons */}
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

      {(stage === "camera" || stage === "detected" || stage === "countdown") && (
        <div className="buttons">
          <button className="btn btn-secondary" onClick={reset}>
            &#x2715; 취소
          </button>
        </div>
      )}

      {error && <p className="error">{error}</p>}

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

// Helpers
function midpoint(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function lerp(a: { x: number; y: number }, b: { x: number; y: number }, t: number) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function drawCurve(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  color: string,
  width: number
) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;

  ctx.moveTo(points[0].x, points[0].y);
  if (points.length === 2) {
    ctx.lineTo(points[1].x, points[1].y);
  } else {
    for (let i = 0; i < points.length - 1; i++) {
      const xc = (points[i].x + points[i + 1].x) / 2;
      const yc = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}
