import { useState, useRef, useCallback } from "react";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

type Stage = "capture" | "analyzing" | "result";

export default function App() {
  const [stage, setStage] = useState<Stage>("capture");
  const [imageData, setImageData] = useState<string | null>(null);
  const [reading, setReading] = useState("");
  const [error, setError] = useState("");
  const [cameraActive, setCameraActive] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  }, []);

  const startCamera = async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 960 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
      setCameraActive(true);
    } catch {
      setError("카메라에 접근할 수 없습니다. 파일 업로드를 이용해주세요.");
    }
  };

  const capturePhoto = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(video, 0, 0);
    const data = canvas.toDataURL("image/jpeg", 0.85);
    setImageData(data);
    stopCamera();
    analyze(data);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");

    const reader = new FileReader();
    reader.onload = () => {
      const data = reader.result as string;
      setImageData(data);
      stopCamera();
      analyze(data);
    };
    reader.readAsDataURL(file);
  };

  const analyze = async (image: string) => {
    setStage("analyzing");
    setError("");

    try {
      const res = await fetch(`${API_URL}/api/read-palm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "분석에 실패했습니다.");
      }

      setReading(data.reading);
      setStage("result");
    } catch (err) {
      setError(err instanceof Error ? err.message : "오류가 발생했습니다.");
      setStage("capture");
    }
  };

  const reset = () => {
    setStage("capture");
    setImageData(null);
    setReading("");
    setError("");
    stopCamera();
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <main className="container">
      <header className="header">
        <h1>AI 손금 리더</h1>
        <p>AI가 당신의 손금을 분석합니다</p>
      </header>

      <div className={`capture-area${imageData ? " has-image" : ""}`}>
        {cameraActive && (
          <video ref={videoRef} autoPlay playsInline muted style={{ transform: "scaleX(-1)" }} />
        )}
        {imageData && !cameraActive && (
          <img src={imageData} alt="손바닥 사진" />
        )}
        {!cameraActive && !imageData && stage === "capture" && (
          <>
            <div className="hand-icon">PALM</div>
            <p className="capture-hint">
              손바닥이 잘 보이도록<br />
              밝은 곳에서 촬영해주세요
            </p>
          </>
        )}
        {stage === "analyzing" && imageData && (
          <div style={{
            position: "absolute", inset: 0,
            background: "rgba(13,10,26,0.7)",
            display: "flex", alignItems: "center", justifyContent: "center",
            borderRadius: "1.1rem", zIndex: 2,
          }}>
            <div className="loading">
              <div className="crystal-ball">&#x1F52E;</div>
              <p>손금을 분석하는 중...</p>
            </div>
          </div>
        )}
      </div>

      <canvas ref={canvasRef} style={{ display: "none" }} />

      {stage === "capture" && (
        <>
          <div className="buttons">
            {!cameraActive ? (
              <button className="btn btn-primary" onClick={startCamera}>
                &#x1F4F7; 카메라 촬영
              </button>
            ) : (
              <button className="btn btn-gold" onClick={capturePhoto}>
                &#x1F4F8; 사진 찍기
              </button>
            )}
            <button
              className="btn btn-secondary"
              onClick={() => fileInputRef.current?.click()}
              disabled={cameraActive}
            >
              &#x1F4C1; 사진 업로드
            </button>
          </div>
          <input
            ref={fileInputRef}
            className="file-input"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileUpload}
          />
        </>
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
