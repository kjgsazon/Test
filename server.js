// server.js (Render)
// =============================================
// 手機 / 瀏覽器：
//   GET  /                     → dashboard.html
//   GET  /health               → 服務是否活著
//   GET  /debug/token          → 檢查 PUSH_TOKEN 是否有吃到
//   GET  /api/latest/2317
//   GET  /api/decision/2317
//
// Windows 端推送：
//   POST /api/push   (需 PUSH_TOKEN)
// =============================================

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ====== 記憶體暫存（Render free 會重啟，資料清空屬正常）======
const STORE = {
  latest: {},
  decision: {},
};

// ====== Token（由 Render 環境變數提供）======
const PUSH_TOKEN = process.env.PUSH_TOKEN || "";

// ====== health ======
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: Math.floor(Date.now() / 1000) });
});

// ====== debug：檢查 Render 是否真的吃到 PUSH_TOKEN ======
app.get("/debug/token", (req, res) => {
  res.json({
    hasToken: Boolean(PUSH_TOKEN),
    tokenLength: (PUSH_TOKEN || "").length,
  });
});

// ====== 取得 latest / decision ======
app.get("/api/latest/:symbol", (req, res) => {
  const s = String(req.params.symbol || "").trim();
  const data = STORE.latest[s];
  if (!data) return res.status(404).json({ ok: false, error: "no_latest" });
  res.json(data);
});

app.get("/api/decision/:symbol", (req, res) => {
  const s = String(req.params.symbol || "").trim();
  const data = STORE.decision[s];
  if (!data) return res.status(404).json({ ok: false, error: "no_decision" });
  res.json(data);
});

// ====== Windows 端推送入口 ======
// payload 範例：
// {
//   "token":"xxxxx",
//   "type":"latest" | "decision",
//   "symbol":"2317",
//   "data":{...}
// }
app.post("/api/push", (req, res) => {
  try {
    const { token, type, symbol, data } = req.body || {};

    if (!PUSH_TOKEN || token !== PUSH_TOKEN) {
      return res.status(401).json({
        ok: false,
        error: "bad_token",
        hasToken: Boolean(PUSH_TOKEN),
      });
    }

    const s = String(symbol || "").trim();
    if (!s) return res.status(400).json({ ok: false, error: "missing_symbol" });

    if (type !== "latest" && type !== "decision") {
      return res.status(400).json({ ok: false, error: "bad_type" });
    }

    if (typeof data !== "object" || data === null) {
      return res.status(400).json({ ok: false, error: "bad_data" });
    }

    const now = Math.floor(Date.now() / 1000);
    const merged = { ...data, symbol: s, ts: data.ts || now };

    if (type === "latest") STORE.latest[s] = merged;
    if (type === "decision") STORE.decision[s] = merged;

    return res.json({ ok: true, type, symbol: s, ts: now });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// ====== Dashboard（dashboard.html 在專案根目錄）======
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// ====== listen ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`server listening on :${PORT}`);
});
