const express = require("express");
const cors = require("cors");

/**
 * Multi-symbol PoC dashboard (mock data)
 * - Multi-symbol: supports switching symbols on UI
 * - Daily analysis: overnight + trend + structure change
 * - Export: download daily report (txt / md)
 *
 * NOTE: current prices/volumes are mock. Later, replace QuoteProviderPoC with a real feed.
 */

// ---- Config ----
const SYMBOLS = [
  { symbol: "2317", name: "鴻海", basePrice: 230, vol: 0.35 },
  { symbol: "2330", name: "台積電", basePrice: 600, vol: 0.65 },
];
const DEFAULT_SYMBOL = SYMBOLS[0].symbol;

// ---- Helpers ----
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function mean(arr) { return arr.reduce((s, x) => s + x, 0) / (arr.length || 1); }
function stddev(arr) {
  if (!arr.length) return 0;
  const m = mean(arr);
  const v = mean(arr.map(x => (x - m) ** 2));
  return Math.sqrt(v);
}
function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return mean(slice);
}
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += -diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}
function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    const cur = bars[i];
    const prev = bars[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    trs.push(tr);
  }
  return mean(trs);
}

// Very small PSAR implementation (good enough for PoC trend state)
function psar(bars, step = 0.02, max = 0.2) {
  if (bars.length < 5) return null;
  let upTrend = bars[bars.length - 1].close >= bars[bars.length - 2].close;
  let af = step;
  let ep = upTrend
    ? Math.max(...bars.slice(0, 5).map(b => b.high))
    : Math.min(...bars.slice(0, 5).map(b => b.low));
  let sar = upTrend
    ? Math.min(...bars.slice(0, 5).map(b => b.low))
    : Math.max(...bars.slice(0, 5).map(b => b.high));

  for (let i = 5; i < bars.length; i++) {
    const b = bars[i];
    sar = sar + af * (ep - sar);

    if (upTrend) {
      sar = Math.min(sar, bars[i - 1].low, bars[i - 2].low);
      if (b.low < sar) {
        upTrend = false;
        sar = ep;
        ep = b.low;
        af = step;
      } else {
        if (b.high > ep) {
          ep = b.high;
          af = Math.min(max, af + step);
        }
      }
    } else {
      sar = Math.max(sar, bars[i - 1].high, bars[i - 2].high);
      if (b.high > sar) {
        upTrend = true;
        sar = ep;
        ep = b.high;
        af = step;
      } else {
        if (b.low < ep) {
          ep = b.low;
          af = Math.min(max, af + step);
        }
      }
    }
  }
  return sar;
}

function dateYYYYMMDD(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

// ---- Mock Quote Provider ----
class QuoteProviderPoC {
  constructor() {
    this.timer = null;
    this.cb = null;
    this.phase = Math.random() * Math.PI * 2;
  }
  onTick(cb) { this.cb = cb; }
  async start(symbols) {
    this.timer = setInterval(() => {
      const now = Date.now();
      symbols.forEach(symCfg => {
        const t = now / 1000;
        const drift = Math.sin((t / 30) + this.phase) * (symCfg.vol * 2.2);
        const noise = (Math.random() - 0.5) * symCfg.vol;
        const price = symCfg.basePrice + drift + noise;

        // mock tick volume
        const vol = Math.floor(10 + Math.random() * 90); // 10~100 (PoC)
        if (this.cb) this.cb({ ts: now, symbol: symCfg.symbol, price: Number(price.toFixed(2)), vol });
      });
    }, 1000);
  }
  async stop() { if (this.timer) clearInterval(this.timer); }
}

// ---- 5m Aggregator (per symbol) ----
class Bar5mAggregator {
  constructor() {
    this.currentBar = null;
    this.onUpdate = null;
    this.onClose = null;
  }
  onBarUpdate(cb) { this.onUpdate = cb; }
  onBarClose(cb) { this.onClose = cb; }

  handleTick(tick) {
    const FIVE_MIN = 5 * 60 * 1000;
    const barStart = Math.floor(tick.ts / FIVE_MIN) * FIVE_MIN;

    if (!this.currentBar || this.currentBar.startTs !== barStart) {
      if (this.currentBar && this.onClose) this.onClose(this.currentBar);
      this.currentBar = {
        startTs: barStart,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: tick.vol || 0,
        ticks: 1,
      };
    } else {
      this.currentBar.high = Math.max(this.currentBar.high, tick.price);
      this.currentBar.low = Math.min(this.currentBar.low, tick.price);
      this.currentBar.close = tick.price;
      this.currentBar.volume += (tick.vol || 0);
      this.currentBar.ticks += 1;
    }
    if (this.onUpdate && this.currentBar) this.onUpdate(this.currentBar);
  }
}

// ---- Analysis Engine ----
function computeIndicatorStateFromBars(barsClosed) {
  const closes = barsClosed.map(b => b.close);
  const lastClose = closes[closes.length - 1];
  const ma20 = sma(closes, 20);
  const bbMid = ma20;
  let bbUpper = null, bbLower = null;
  if (closes.length >= 20) {
    const slice = closes.slice(-20);
    const sd = stddev(slice);
    bbUpper = bbMid + 2 * sd;
    bbLower = bbMid - 2 * sd;
  }
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(barsClosed, 14);
  const sar = psar(barsClosed);

  const bollinger =
    bbUpper == null || bbLower == null ? null :
      (lastClose >= bbUpper ? "UPPER" : (lastClose <= bbLower ? "LOWER" : "MID"));

  const rsiZone =
    rsi14 == null ? null :
      (rsi14 >= 70 ? "HIGH" : (rsi14 <= 30 ? "LOW" : "MID"));

  const sarTrend = sar == null ? null : (lastClose >= sar ? "ABOVE" : "BELOW");
  const midMA = ma20 == null ? null : (lastClose >= ma20 ? "ABOVE" : "BELOW");

  return {
    numbers: { ma20, bbUpper, bbLower, bbMid, rsi14, atr14, sar, lastClose },
    state: { bollinger, rsiZone, sarTrend, midMA }
  };
}

function detectStructureEventsFromBars(barsClosed) {
  if (barsClosed.length < 50) return [];
  const prev20 = barsClosed.slice(-40, -20);
  const prevHigh = Math.max(...prev20.map(b => b.high));
  const prevLow = Math.min(...prev20.map(b => b.low));
  const lastClose = barsClosed[barsClosed.length - 1].close;

  const events = [];
  if (lastClose > prevHigh) events.push("BREAK_PREV_HIGH");
  if (lastClose < prevLow) events.push("SUPPORT_BREAK");
  return events;
}

function abnormalVolumeSpike(barsClosed) {
  if (barsClosed.length < 30) return false;
  const last = barsClosed[barsClosed.length - 1];
  const prev = barsClosed.slice(-11, -1);
  const avgVol = mean(prev.map(b => b.volume || 0));
  if (avgVol <= 0) return false;
  return last.volume >= avgVol * 1.8;
}

function generateDailyAnalysisFromState(symState) {
  const bars = symState.bars5mClosed || [];
  const st = symState.indicatorState;
  const ind = symState.indicators;

  if (!st || !ind || bars.length < 30) {
    return {
      overnight_trade: {
        risk_level: "MEDIUM",
        summary: ["資料累積中（PoC）", "尚未形成穩定結構判斷"],
        action: "先觀察，等待資料更完整"
      },
      trend_analysis: {
        trend_state: "RANGE",
        structure_intact: true,
        summary: ["資料不足以判定中期趨勢", "先以區間震盪視之"],
        action: "避免追價，等待方向"
      },
      structure_change: { type: "NONE", reason: "資料不足" },
      daily_conclusion: "資料累積中，暫以觀望為主"
    };
  }

  const atr14 = ind.atr14;
  const lastBar = bars[bars.length - 1];
  const todayRange = Math.max(0, lastBar.high - lastBar.low);

  // Overnight risk
  let risk = "LOW";
  if (st.bollinger === "UPPER" || (atr14 != null && todayRange > atr14 * 0.9) || st.rsiZone === "HIGH") risk = "HIGH";
  else if (st.bollinger === "MID") risk = "MEDIUM";

  const riskSummary = [];
  if (st.bollinger === "UPPER") riskSummary.push("價格靠近布林上緣，追價風險偏高");
  if (st.rsiZone === "HIGH") riskSummary.push("RSI 偏高，容易被洗");
  if (atr14 != null && todayRange > atr14 * 0.9) riskSummary.push("當根波動接近 ATR，短線震盪加劇");
  if (riskSummary.length === 0) riskSummary.push("位置與波動相對可控");

  const riskAction =
    risk === "HIGH" ? "不建議追價；若布局請降低部位、等拉回" :
    risk === "MEDIUM" ? "可觀察回測支撐反應再決定" :
    "風險可控，分批布局較佳";

  // Trend
  let trend = "RANGE";
  let structureIntact = true;
  if (st.midMA === "ABOVE" && st.sarTrend === "ABOVE" && !symState.structureEvents.includes("SUPPORT_BREAK")) trend = "BULLISH";
  if (symState.structureEvents.includes("SUPPORT_BREAK")) { trend = "WEAKENING"; structureIntact = false; }

  const trendSummary = [];
  if (trend === "BULLISH") {
    trendSummary.push("價格維持在中期均線之上，趨勢偏多");
    trendSummary.push("SAR 未被跌破，結構尚完整");
  } else if (trend === "WEAKENING") {
    trendSummary.push("跌破關鍵支撐，結構轉弱");
    trendSummary.push("需留意反彈是否無力");
  } else {
    trendSummary.push("價格與均線糾纏，偏區間整理");
    trendSummary.push("等待突破或跌破確認方向");
  }

  const trendAction =
    trend === "BULLISH" ? "拉回不破關鍵支撐可偏多思考" :
    trend === "WEAKENING" ? "操作宜保守，避免做多硬扛" :
    "區間內不追，等方向出來";

  // Structure change
  const spike = symState.volumeSpike === true;
  let structureType = "NONE";
  let structureReason = "未出現關鍵結構事件";
  if (symState.structureEvents.includes("BREAK_PREV_HIGH") && spike) {
    structureType = "STRENGTHEN";
    structureReason = "放量突破前高（結構轉強）";
  } else if (symState.structureEvents.includes("SUPPORT_BREAK") && spike) {
    structureType = "WEAKEN";
    structureReason = "放量跌破支撐（結構轉弱）";
  } else if (symState.structureEvents.includes("BREAK_PREV_HIGH")) {
    structureType = "STRENGTHEN";
    structureReason = "突破前高（需觀察是否站穩）";
  } else if (symState.structureEvents.includes("SUPPORT_BREAK")) {
    structureType = "WEAKEN";
    structureReason = "跌破支撐（需留意反彈力道）";
  }

  const conclusion =
    trend === "BULLISH" && risk === "HIGH" ? "趨勢偏多但位置偏高，不宜追價" :
    trend === "BULLISH" ? "趨勢偏多，拉回較佳" :
    trend === "WEAKENING" ? "結構轉弱，操作宜保守" :
    "區間盤整，耐心等方向";

  return {
    overnight_trade: {
      risk_level: risk,
      summary: riskSummary.slice(0, 3),
      action: riskAction
    },
    trend_analysis: {
      trend_state: trend,
      structure_intact: structureIntact,
      summary: trendSummary.slice(0, 3),
      action: trendAction
    },
    structure_change: { type: structureType, reason: structureReason },
    daily_conclusion: conclusion
  };
}

function exportDailyReport(symbol, name, date, analysis, format = "txt") {
  const risk = analysis.overnight_trade;
  const trend = analysis.trend_analysis;
  const sc = analysis.structure_change;

  if (format === "md") {
    return [
      `# ${symbol} ${name}｜${date} 每日分析`,
      ``,
      `## 隔日沖分析`,
      `- 風險：**${risk.risk_level}**`,
      ...risk.summary.map(s => `- ${s}`),
      `- 👉 ${risk.action}`,
      ``,
      `## 趨勢分析`,
      `- 狀態：**${trend.trend_state}** ${trend.structure_intact ? "" : "（結構轉弱）"}`,
      ...trend.summary.map(s => `- ${s}`),
      `- 👉 ${trend.action}`,
      ``,
      `## 結構變化`,
      `- **${sc.type}**：${sc.reason}`,
      ``,
      `## 一句話總結`,
      `> ${analysis.daily_conclusion}`,
      ``,
      `> 註：目前為 PoC 模擬資料；接正式即時行情只需替換 QuoteProvider。`
    ].join("\n");
  }

  const blocks = [
    `【${symbol} ${name}｜${date} 每日分析】`,
    ``,
    `一、隔日沖分析`,
    `風險：${risk.risk_level}`,
    ...risk.summary.map(s => `- ${s}`),
    `👉 ${risk.action}`,
    ``,
    `二、趨勢分析`,
    `狀態：${trend.trend_state}${trend.structure_intact ? "（結構未破）" : "（結構轉弱）"}`,
    ...trend.summary.map(s => `- ${s}`),
    `👉 ${trend.action}`,
    ``,
    `三、結構變化`,
    `${sc.type}：${sc.reason}`,
    ``,
    `四、一句話總結`,
    `${analysis.daily_conclusion}`,
    ``,
    `（註）目前為 PoC 模擬資料；接正式即時行情只需替換 QuoteProvider。`
  ];

  return blocks.join("\n");
}

// ---- Runtime State (per symbol) ----
function makeSymbolState(cfg) {
  return {
    symbol: cfg.symbol,
    name: cfg.name,
    date: dateYYYYMMDD(),

    lastQuote: null,
    currentBar5m: null,
    bars5mClosed: [],

    indicators: null,
    indicatorState: null,
    structureEvents: [],
    volumeSpike: false,

    dailyAnalysis: null,
    lastAnalysisTs: null
  };
}

const stateBySymbol = Object.fromEntries(SYMBOLS.map(cfg => [cfg.symbol, makeSymbolState(cfg)]));
const aggBySymbol = Object.fromEntries(SYMBOLS.map(cfg => [cfg.symbol, new Bar5mAggregator()]));

for (const cfg of SYMBOLS) {
  const st = stateBySymbol[cfg.symbol];
  const agg = aggBySymbol[cfg.symbol];

  agg.onBarUpdate((bar) => { st.currentBar5m = bar; });

  agg.onBarClose((bar) => {
    st.bars5mClosed.push(bar);
    if (st.bars5mClosed.length > 600) st.bars5mClosed = st.bars5mClosed.slice(-600);

    const { numbers, state } = computeIndicatorStateFromBars(st.bars5mClosed);
    st.indicators = numbers;
    st.indicatorState = state;
    st.structureEvents = detectStructureEventsFromBars(st.bars5mClosed);
    st.volumeSpike = abnormalVolumeSpike(st.bars5mClosed);

    st.dailyAnalysis = generateDailyAnalysisFromState(st);
    st.lastAnalysisTs = Date.now();
  });
}

const provider = new QuoteProviderPoC();
provider.onTick((tick) => {
  const st = stateBySymbol[tick.symbol];
  if (!st) return;
  st.lastQuote = tick;
  aggBySymbol[tick.symbol].handleTick(tick);
});
provider.start(SYMBOLS);

// ---- Express App ----
const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/symbols", (req, res) => {
  res.json({ symbols: SYMBOLS.map(s => ({ symbol: s.symbol, name: s.name })) });
});

app.get("/api/realtime/state", (req, res) => {
  const symbol = (req.query.symbol || DEFAULT_SYMBOL).toString();
  const st = stateBySymbol[symbol];
  if (!st) return res.status(404).json({ error: "Unknown symbol" });
  res.json(st);
});

app.get("/api/daily-analysis", (req, res) => {
  const symbol = (req.query.symbol || DEFAULT_SYMBOL).toString();
  const st = stateBySymbol[symbol];
  if (!st) return res.status(404).json({ error: "Unknown symbol" });
  if (!st.dailyAnalysis) return res.status(404).json({ error: "Daily analysis not ready" });
  res.json({ symbol: st.symbol, name: st.name, date: st.date, analysis: st.dailyAnalysis, updatedAt: st.lastAnalysisTs });
});

app.get("/api/daily-analysis/export", (req, res) => {
  const symbol = (req.query.symbol || DEFAULT_SYMBOL).toString();
  const format = (req.query.format || "txt").toString().toLowerCase();
  const st = stateBySymbol[symbol];
  if (!st) return res.status(404).send("Unknown symbol");
  if (!st.dailyAnalysis) return res.status(404).send("Daily analysis not ready");

  const safeFormat = format === "md" ? "md" : "txt";
  const text = exportDailyReport(st.symbol, st.name, st.date, st.dailyAnalysis, safeFormat);
  const ext = safeFormat === "md" ? "md" : "txt";

  res.setHeader("Content-Disposition", `attachment; filename=${st.symbol}_daily_report.${ext}`);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(text);
});

app.get("/", (req, res) => {
  res.type("html").send(INDEX_HTML);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server listening on port", PORT));

// ---- Frontend (single-page) ----
const INDEX_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>台股看盤（PoC：多標的 + 每日分析）</title>
  <style>
    :root{--bg:#0b1020; --card:#111a33; --text:#e8eefc; --muted:#9fb0d2; --line:#223058; --good:#22c55e; --bad:#ef4444; --warn:#f59e0b;}
    *{box-sizing:border-box}
    body{margin:0;background:linear-gradient(180deg,#070b16 0%, #0b1020 40%, #0b1020 100%);color:var(--text);font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans TC", Arial;}
    .wrap{max-width:1100px;margin:0 auto;padding:18px}
    .row{display:grid;grid-template-columns:1.2fr 1fr;gap:14px}
    @media (max-width: 900px){.row{grid-template-columns:1fr}}
    .card{background:rgba(17,26,51,.86);border:1px solid rgba(34,48,88,.65);border-radius:16px;padding:14px;box-shadow:0 10px 30px rgba(0,0,0,.25);}
    .top{display:flex;align-items:flex-end;justify-content:space-between;gap:12px}
    .title{font-size:22px;font-weight:700;letter-spacing:.3px}
    .sub{color:var(--muted);font-size:12px;margin-top:4px}
    .price{font-size:44px;font-weight:800;line-height:1}
    .chg{font-size:14px;margin-top:8px}
    .pill{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;font-size:12px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04);color:var(--muted)}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
    .kv{border-top:1px solid rgba(34,48,88,.6);padding-top:10px}
    .k{color:var(--muted);font-size:12px}
    .v{font-size:14px;font-weight:700;margin-top:4px}
    .mono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;}
    .bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .dot{width:7px;height:7px;border-radius:99px;background:var(--good);display:inline-block}
    .dot.bad{background:var(--bad)}
    table{width:100%;border-collapse:collapse;margin-top:10px}
    th,td{padding:8px 8px;border-bottom:1px solid rgba(34,48,88,.6);text-align:right;font-size:12px}
    th{color:var(--muted);font-weight:600}
    td:first-child, th:first-child{text-align:left}
    .chartWrap{height:360px}
    canvas{width:100%;height:100%;background:rgba(6,10,20,.35);border:1px solid rgba(34,48,88,.55);border-radius:14px}
    .foot{margin-top:12px;color:var(--muted);font-size:12px}

    .banner{display:none;border-radius:16px;border:1px solid rgba(255,255,255,.12);padding:12px 14px;margin-top:14px;box-shadow:0 10px 30px rgba(0,0,0,.25);}
    .banner strong{display:block;font-size:16px}
    .banner small{display:block;margin-top:4px;color:rgba(255,255,255,.85)}
    .banner.none{display:block;background:rgba(255,255,255,.04)}
    .banner.up{display:block;background:rgba(34,197,94,.18);border-color:rgba(34,197,94,.35)}
    .banner.down{display:block;background:rgba(239,68,68,.18);border-color:rgba(239,68,68,.35)}

    .analysisGrid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}
    @media (max-width: 900px){.analysisGrid{grid-template-columns:1fr}}
    .btn{cursor:pointer;user-select:none;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:var(--text);padding:8px 12px;border-radius:12px;font-weight:700}
    .btn:hover{background:rgba(255,255,255,.09)}
    .select{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:var(--text);padding:8px 10px;border-radius:12px}
    .mini{font-size:12px;color:var(--muted)}
    .tag{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;font-size:12px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04);color:var(--muted)}
    .tag.good{border-color:rgba(34,197,94,.35);background:rgba(34,197,94,.12);color:#d8ffe7}
    .tag.bad{border-color:rgba(239,68,68,.35);background:rgba(239,68,68,.12);color:#ffe2e2}
    .tag.warn{border-color:rgba(245,158,11,.35);background:rgba(245,158,11,.12);color:#fff2d8}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <div class="title">
          <span id="name">--</span> <span class="mono" id="symbol">--</span>
          <span class="pill">PoC 模擬即時</span>
        </div>
        <div class="sub">1 秒更新（UI）・5 分 K 收盤事件（bar-close）・每日分析（PoC）</div>
      </div>
      <div class="bar">
        <select id="symbolSelect" class="select" title="切換標的"></select>
        <span class="pill"><span id="statusDot" class="dot"></span> <span id="statusText">連線中</span></span>
        <span class="pill">距離 5 分收盤：<span class="mono" id="countdown">--:--</span></span>
        <span class="pill">最後更新：<span class="mono" id="lastTs">--</span></span>
      </div>
    </div>

    <div id="structureBanner" class="banner none">
      <strong>➖ 結構未變</strong>
      <small>今天沒有出現關鍵結構事件，維持原策略即可。</small>
    </div>

    <div class="row" style="margin-top:14px;">
      <div class="card">
        <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:10px;">
          <div>
            <div class="k">即時價</div>
            <div class="price mono" id="price">--</div>
            <div class="chg" id="chg"><span class="pill">漲跌：--</span> <span class="pill">漲跌幅：--</span></div>
            <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
              <span id="riskTag" class="tag">隔日沖：--</span>
              <span id="trendTag" class="tag">趨勢：--</span>
            </div>
            <div class="mini" style="margin-top:6px">* 判斷為 PoC；接真行情後才具參考性</div>
          </div>
          <div class="kv" style="min-width:260px;">
            <div class="k">當根 5 分 K（in-progress）</div>
            <div class="grid2">
              <div><div class="k">O</div><div class="v mono" id="o">--</div></div>
              <div><div class="k">H</div><div class="v mono" id="h">--</div></div>
              <div><div class="k">L</div><div class="v mono" id="l">--</div></div>
              <div><div class="k">C</div><div class="v mono" id="c">--</div></div>
            </div>
          </div>
        </div>

        <div style="margin-top:14px;">
          <div class="k">近 60 根 5 分 K（簡易 K 線圖）</div>
          <div class="chartWrap" style="margin-top:8px;">
            <canvas id="chart" width="1100" height="360"></canvas>
          </div>
          <div class="foot">目前報價為 PoC 模擬。接正式即時行情只需替換 QuoteProvider。</div>
        </div>
      </div>

      <div class="card">
        <div class="k">最近 50 根已收盤 5 分 K</div>
        <table>
          <thead>
            <tr><th>時間</th><th>O</th><th>H</th><th>L</th><th>C</th><th>量</th></tr>
          </thead>
          <tbody id="bars"></tbody>
        </table>
      </div>
    </div>

    <div class="analysisGrid">
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <div>
            <div class="title" style="font-size:16px">📊 每日分析（收盤版）</div>
            <div class="sub">同一套資料同時輸出：隔日沖 + 趨勢 + 結構變化（不切換）</div>
          </div>
          <div style="display:flex;gap:10px;align-items:center">
            <button class="btn" id="downloadTxt">下載 TXT</button>
            <button class="btn" id="downloadMd">下載 MD</button>
          </div>
        </div>

        <div style="margin-top:12px;">
          <div class="k">隔日沖分析</div>
          <div class="v" id="overnightText">--</div>
        </div>
        <div style="margin-top:12px;">
          <div class="k">趨勢分析</div>
          <div class="v" id="trendText">--</div>
        </div>
        <div style="margin-top:12px;">
          <div class="k">結構變化</div>
          <div class="v" id="structureText">--</div>
        </div>
        <div style="margin-top:12px;">
          <div class="k">一句話總結</div>
          <div class="v" id="conclusionText">--</div>
        </div>
      </div>

      <div class="card">
        <div class="title" style="font-size:16px">🧾 指標狀態（驗證用）</div>
        <div class="sub">系統用狀態做判斷，不用你去記數字</div>
        <div style="margin-top:12px;display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="kv"><div class="k">布林</div><div class="v mono" id="bbState">--</div></div>
          <div class="kv"><div class="k">RSI</div><div class="v mono" id="rsiState">--</div></div>
          <div class="kv"><div class="k">SAR</div><div class="v mono" id="sarState">--</div></div>
          <div class="kv"><div class="k">中期均線</div><div class="v mono" id="maState">--</div></div>
          <div class="kv"><div class="k">ATR(14)</div><div class="v mono" id="atrNum">--</div></div>
          <div class="kv"><div class="k">Volume Spike</div><div class="v mono" id="vspike">--</div></div>
        </div>
        <div class="foot">* 這些是輔助你確認「系統不是亂講」。</div>
      </div>
    </div>
  </div>

<script>
  let currentSymbol = "${DEFAULT_SYMBOL}";
  const symbolsUrl = "/api/symbols";
  const stateUrl = (sym) => "/api/realtime/state?symbol=" + encodeURIComponent(sym);
  const analysisUrl = (sym) => "/api/daily-analysis?symbol=" + encodeURIComponent(sym);
  const exportUrl = (sym, fmt) => "/api/daily-analysis/export?symbol=" + encodeURIComponent(sym) + "&format=" + fmt;

  function fmtTs(ms){
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2,'0');
    const mm = String(d.getMinutes()).padStart(2,'0');
    const ss = String(d.getSeconds()).padStart(2,'0');
    return hh + ":" + mm + ":" + ss;
  }

  function countdownTo5m(nowMs){
    const FIVE_MIN = 5 * 60 * 1000;
    const next = (Math.floor(nowMs / FIVE_MIN) + 1) * FIVE_MIN;
    const diff = Math.max(0, next - nowMs);
    const m = String(Math.floor(diff / 60000)).padStart(2,'0');
    const s = String(Math.floor((diff % 60000)/1000)).padStart(2,'0');
    return m + ":" + s;
  }

  function setStatus(ok, warnText){
    const dot = document.getElementById("statusDot");
    const text = document.getElementById("statusText");
    if(ok){ dot.className = "dot"; text.textContent = "連線中"; }
    else { dot.className = "dot bad"; text.textContent = warnText || "資料延遲"; }
  }

  function drawCandles(canvas, bars){
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0,0,w,h);
    ctx.strokeStyle = "rgba(159,176,210,0.12)";
    for(let i=1;i<5;i++){
      const y = (h/5)*i;
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke();
    }
    if(!bars || bars.length === 0) return;

    const maxBars = 60;
    const data = bars.slice(-maxBars);
    let hi = -Infinity, lo = Infinity;
    data.forEach(b=>{ hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); });
    if(!(isFinite(hi)&&isFinite(lo)) || hi===lo) { hi = lo + 1; }

    const pad = 16;
    const plotW = w - pad*2;
    const plotH = h - pad*2;
    const xStep = plotW / data.length;
    const candleW = Math.max(3, xStep*0.55);

    function yOf(price){
      const t = (price - lo) / (hi - lo);
      return pad + (1 - t) * plotH;
    }

    data.forEach((b, i)=>{
      const x = pad + i * xStep + xStep/2;
      const yO = yOf(b.open), yC = yOf(b.close), yH = yOf(b.high), yL = yOf(b.low);
      const up = b.close >= b.open;
      ctx.strokeStyle = up ? "rgba(34,197,94,0.9)" : "rgba(239,68,68,0.9)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke();
      ctx.fillStyle = up ? "rgba(34,197,94,0.65)" : "rgba(239,68,68,0.65)";
      const top = Math.min(yO, yC);
      const bot = Math.max(yO, yC);
      const bodyH = Math.max(2, bot - top);
      ctx.fillRect(x - candleW/2, top, candleW, bodyH);
    });
  }

  function renderBarsTable(bars){
    const tbody = document.getElementById("bars");
    tbody.innerHTML = "";
    const data = (bars||[]).slice(-50).reverse();
    for(const b of data){
      const t = new Date(b.startTs);
      const hh = String(t.getHours()).padStart(2,'0');
      const mm = String(t.getMinutes()).padStart(2,'0');
      const tr = document.createElement("tr");
      tr.innerHTML =
        '<td class="mono">' + hh + ':' + mm + '</td>' +
        '<td class="mono">' + b.open.toFixed(2) + '</td>' +
        '<td class="mono">' + b.high.toFixed(2) + '</td>' +
        '<td class="mono">' + b.low.toFixed(2) + '</td>' +
        '<td class="mono">' + b.close.toFixed(2) + '</td>' +
        '<td class="mono">' + ((b.volume||0).toFixed(0)) + '</td>';
      tbody.appendChild(tr);
    }
  }

  function renderStructureBanner(structureChange){
    const el = document.getElementById("structureBanner");
    if(!structureChange){
      el.className = "banner none";
      el.innerHTML = "<strong>➖ 結構未變</strong><small>資料尚未形成結構事件。</small>";
      return;
    }
    const t = structureChange.type;
    if(t === "STRENGTHEN"){
      el.className = "banner up";
      el.innerHTML = "<strong>🔼 結構轉強</strong><small>" + (structureChange.reason || "") + "</small>";
    } else if(t === "WEAKEN"){
      el.className = "banner down";
      el.innerHTML = "<strong>🔽 結構轉弱</strong><small>" + (structureChange.reason || "") + "</small>";
    } else {
      el.className = "banner none";
      el.innerHTML = "<strong>➖ 結構未變</strong><small>" + (structureChange.reason || "今天沒有出現關鍵結構事件") + "</small>";
    }
  }

  function renderTags(analysis){
    const riskTag = document.getElementById("riskTag");
    const trendTag = document.getElementById("trendTag");
    if(!analysis){
      riskTag.className = "tag"; riskTag.textContent = "隔日沖：--";
      trendTag.className = "tag"; trendTag.textContent = "趨勢：--";
      return;
    }

    const r = analysis.overnight_trade.risk_level;
    riskTag.textContent = "隔日沖：" + r;
    riskTag.className = "tag " + (r === "HIGH" ? "bad" : r === "MEDIUM" ? "warn" : "good");

    const t = analysis.trend_analysis.trend_state;
    trendTag.textContent = "趨勢：" + t;
    trendTag.className = "tag " + (t === "WEAKENING" ? "bad" : t === "BULLISH" ? "good" : "warn");
  }

  async function loadSymbols(){
    const r = await fetch(symbolsUrl, { cache: "no-store" });
    const data = await r.json();
    const sel = document.getElementById("symbolSelect");
    sel.innerHTML = "";
    data.symbols.forEach(s => {
      const opt = document.createElement("option");
      opt.value = s.symbol;
      opt.textContent = s.symbol + " " + s.name;
      sel.appendChild(opt);
    });
    sel.value = currentSymbol;
    sel.onchange = () => {
      currentSymbol = sel.value;
      tick();
      loadDailyAnalysis();
    };
  }

  async function loadDailyAnalysis(){
    try{
      const r = await fetch(analysisUrl(currentSymbol), { cache: "no-store" });
      if(!r.ok) return;
      const data = await r.json();
      const a = data.analysis;

      document.getElementById("overnightText").textContent =
        a.overnight_trade.summary.join("；") + "。👉 " + a.overnight_trade.action;

      document.getElementById("trendText").textContent =
        a.trend_analysis.summary.join("；") + "。👉 " + a.trend_analysis.action;

      document.getElementById("structureText").textContent =
        a.structure_change.type + "： " + a.structure_change.reason;

      document.getElementById("conclusionText").textContent = a.daily_conclusion;

      renderStructureBanner(a.structure_change);
      renderTags(a);

      document.getElementById("downloadTxt").onclick = () => window.location.href = exportUrl(currentSymbol, "txt");
      document.getElementById("downloadMd").onclick = () => window.location.href = exportUrl(currentSymbol, "md");
    }catch(e){ /* ignore */ }
  }

  async function tick(){
    try{
      const r = await fetch(stateUrl(currentSymbol), { cache: "no-store" });
      const s = await r.json();
      document.getElementById("name").textContent = s.name || "--";
      document.getElementById("symbol").textContent = s.symbol || "--";

      const now = Date.now();
      document.getElementById("countdown").textContent = countdownTo5m(now);

      if(!s.lastQuote){
        setStatus(false, "等待資料");
        return;
      }
      const age = now - s.lastQuote.ts;
      setStatus(age <= 3000, age <= 3000 ? "" : "資料延遲");

      document.getElementById("lastTs").textContent = fmtTs(s.lastQuote.ts);
      document.getElementById("price").textContent = s.lastQuote.price.toFixed(2);

      const closed = s.bars5mClosed || [];
      if(closed.length > 0){
        const prevClose = closed[closed.length - 1].close;
        const chg = s.lastQuote.price - prevClose;
        const pct = (chg / prevClose) * 100;
        const sign = chg >= 0 ? "+" : "";
        document.getElementById("chg").innerHTML =
          '<span class="pill">漲跌： <span class="mono">' + sign + chg.toFixed(2) + '</span></span>' +
          ' <span class="pill">漲跌幅： <span class="mono">' + sign + pct.toFixed(2) + '%</span></span>';
      } else {
        document.getElementById("chg").innerHTML =
          '<span class="pill">漲跌： --</span> <span class="pill">漲跌幅： --</span>';
      }

      if(s.currentBar5m){
        document.getElementById("o").textContent = s.currentBar5m.open.toFixed(2);
        document.getElementById("h").textContent = s.currentBar5m.high.toFixed(2);
        document.getElementById("l").textContent = s.currentBar5m.low.toFixed(2);
        document.getElementById("c").textContent = s.currentBar5m.close.toFixed(2);
      }

      document.getElementById("bbState").textContent = (s.indicatorState && s.indicatorState.bollinger) ? s.indicatorState.bollinger : "--";
      document.getElementById("rsiState").textContent = (s.indicatorState && s.indicatorState.rsiZone) ? s.indicatorState.rsiZone : "--";
      document.getElementById("sarState").textContent = (s.indicatorState && s.indicatorState.sarTrend) ? s.indicatorState.sarTrend : "--";
      document.getElementById("maState").textContent = (s.indicatorState && s.indicatorState.midMA) ? s.indicatorState.midMA : "--";
      document.getElementById("atrNum").textContent = (s.indicators && s.indicators.atr14 != null) ? Number(s.indicators.atr14).toFixed(2) : "--";
      document.getElementById("vspike").textContent = (s.volumeSpike === true) ? "YES" : "NO";

      const bars = (s.bars5mClosed || []).slice();
      if(s.currentBar5m) bars.push(s.currentBar5m);
      drawCandles(document.getElementById("chart"), bars);
      renderBarsTable(s.bars5mClosed || []);

    }catch(e){
      setStatus(false, "連線失敗");
    }
  }

  // init
  loadSymbols();
  setInterval(tick, 1000);
  tick();
  setInterval(loadDailyAnalysis, 5000);
  loadDailyAnalysis();
</script>
</body>
</html>`;
