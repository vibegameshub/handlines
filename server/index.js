const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk").default;

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:5173", "https://*.pages.dev"];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowed = allowedOrigins.some((o) =>
      o.includes("*") ? new RegExp(o.replace("*", ".*")).test(origin) : o === origin
    );
    callback(null, allowed);
  },
}));
app.use(express.json({ limit: "10mb" }));

const anthropic = new Anthropic();

const SYSTEM_PROMPT = `당신은 수천 년의 지혜를 가진 신비로운 손금 전문가입니다.
사용자가 보낸 손바닥 사진을 보고 손금을 분석해주세요.

다음 형식으로 분석해주세요:

1. **생명선 (Life Line)** - 건강과 활력에 대한 분석
2. **두뇌선 (Head Line)** - 지성과 사고방식에 대한 분석
3. **감정선 (Heart Line)** - 감정과 인간관계에 대한 분석
4. **운명선 (Fate Line)** - 운명과 커리어에 대한 분석
5. **종합 운세** - 전체적인 운세와 조언

규칙:
- 따뜻하고 긍정적인 톤을 유지하세요
- 신비롭고 흥미로운 분위기로 작성하세요
- 구체적인 관찰을 포함하세요 (선의 길이, 깊이, 갈래 등)
- 각 섹션은 2-3문장으로 작성하세요
- 마지막에 한 줄로 "본 분석은 재미를 위한 것이며, 전문적인 조언이 아닙니다." 라고 덧붙여주세요
- 한국어로 작성하세요`;

app.post("/api/read-palm", async (req, res) => {
  try {
    const { image } = req.body;

    if (!image) {
      return res.status(400).json({ error: "이미지가 필요합니다." });
    }

    const base64Data = image.replace(/^data:image\/\w+;base64,/, "");

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: base64Data,
              },
            },
            { type: "text", text: "이 손금을 분석해주세요." },
          ],
        },
      ],
    });

    const reading =
      response.content[0].type === "text" ? response.content[0].text : "";

    res.json({ reading });
  } catch (error) {
    console.error("Palm reading error:", error);
    res.status(500).json({
      error: "손금 분석 중 오류가 발생했습니다. 다시 시도해주세요.",
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Palm reader server running on port ${PORT}`);
});
