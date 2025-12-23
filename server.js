
/**
 * 2317 Realtime Dashboard (Trade-grade architecture)
 * - Source: Fugle MarketData WebSocket (trades + books) OR PoC mock
 * - Output: HTTP state + WebSocket push to UI
 *
 * ENV:
 *   QUOTE_SOURCE = fugle | mock   (default: mock)
 *   FUGLE_API_KEY = <YOUR_API_KEY> (required when QUOTE_SOURCE=fugle)
 *   SYMBOL = 2317 (default)
 */
const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const SYMBOL = process.env.SYMBOL || "2317";
const NAME = process.env.NAME || "鴻海";
const QUOTE_SOURCE = (process.env.QUOTE_SOURCE || "mock").toLowerCase();

/* =========================
   State
========================= */
const state = {
  symbol: SYMBOL,
  name: NAME,
  serverTs: null,
  last: null,       // { ts(ms), price, size, seq, side? }
  book: null,       // { ts(ms), bids:[{price,size}], asks:[{price,size}] }
  bar5m: null,      // current 5m bar
  bars5mClosed: [],
  signals: [],      // recent signals
};

/* =========================
   Utils
========================= */
const FIVE_MIN = 5 * 60 * 1000;
const floor5m = (ts) => Math.floor(ts / FIVE_MIN) * FIVE_MIN;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function pushSignal(sig) {
  state.signals.push(sig);
  if (state.signals.length > 200) state.signals.shift();
  broadcast({ type: "signal", ...sig });
}

function nowMs() { return Date.now(); }

/* =========================
   5m Aggregation (from ticks)
========================= */
function updateBar5m(tick) {
  const startTs = floor5m(tick.ts);
  if (!state.bar5m || state.bar5m.startTs !== startTs) {
    if (state.bar5m) {
      state.bars5mClosed.push(state.bar5m);
      if (state.bars5mClosed.length > 200) state.bars5mClosed.shift();
    }
    state.bar5m = {
      startTs,
      open: tick.price,
      high: tick.price,
      low: tick.price,
      close: tick.price,
      volume: tick.size || 0,
    };
  } else {
    state.bar5m.high = Math.max(state.bar5m.high, tick.price);
    state.bar5m.low  = Math.min(state.bar5m.low, tick.price);
    state.bar5m.close = tick.price;
    state.bar5m.volume += (tick.size || 0);
  }
}

/* =========================
   Big order / whale detection
   (requires ticks; better with book)
========================= */
class RollingStats {
  constructor(max = 300) {
    this.max = max;
    this.arr = [];
  }
  push(x) {
    this.arr.push(x);
    if (this.arr.length > this.max) this.arr.shift();
  }
  median() {
    if (this.arr.length === 0) return null;
    const a = [...this.arr].sort((p, q) => p - q);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  avg() {
    if (this.arr.length === 0) return null;
    const s = this.arr.reduce((acc, v) => acc + v, 0);
    return s / this.arr.length;
  }
}

const stats = {
  tradeSize: new RollingStats(300),
  topBidSize: new RollingStats(300),
  topAskSize: new RollingStats(300),
};

function inferSideFromBook(tradePrice) {
  const b = state.book;
  if (!b || !b.bids?.length || !b.asks?.length) return "UNK";
  const bid1 = b.bids[0].price;
  const ask1 = b.asks[0].price;
  if (tradePrice >= ask1) return "BUY";
  if (tradePrice <= bid1) return "SELL";
  return "MID";
}

function detectWhaleOnTrade(tick) {
  // thresholds tuned for TW stocks; adjust per symbol if needed
  const minLots = 800;               // >= 800 shares as baseline
  const minNotional = 3_000_000;     // >= 300萬台幣
  const multMedian = 6;              // >= 6x median size

  const size = tick.size || 0;
  const notional = size * (tick.price || 0);

  stats.tradeSize.push(size);
  const med = stats.tradeSize.median() || 0;

  const bigByAbs = size >= minLots || notional >= minNotional;
  const bigByRel = med > 0 ? size >= med * multMedian : false;

  if (!(bigByAbs || bigByRel)) return;

  const side = tick.side || inferSideFromBook(tick.price);
  const level = (notional >= 8_000_000 || size >= 3000) ? "HIGH" : "MED";

  pushSignal({
    ts: tick.ts,
    kind: "BIG_TRADE",
    level,
    symbol: SYMBOL,
    price: tick.price,
    size,
    notional,
    side,
    reason: {
      minLots, minNotional, multMedian,
      medianSize: med || null,
    },
  });
}

function detectBookWall(book) {
  if (!book?.bids?.length || !book?.asks?.length) return;

  const bid1 = book.bids[0];
  const ask1 = book.asks[0];

  stats.topBidSize.push(bid1.size);
  stats.topAskSize.push(ask1.size);

  const bidMed = stats.topBidSize.median() || 0;
  const askMed = stats.topAskSize.median() || 0;

  // Wall definition: top1 size >= max(3000, 8x median)
  const bidWall = bid1.size >= Math.max(3000, bidMed * 8);
  const askWall = ask1.size >= Math.max(3000, askMed * 8);

  if (bidWall) {
    pushSignal({
      ts: book.ts,
      kind: "BOOK_WALL",
      level: bid1.size >= 10000 ? "HIGH" : "MED",
      symbol: SYMBOL,
      side: "BID",
      price: bid1.price,
      size: bid1.size,
      reason: { bidMedian: bidMed || null },
    });
  }
  if (askWall) {
    pushSignal({
      ts: book.ts,
      kind: "BOOK_WALL",
      level: ask1.size >= 10000 ? "HIGH" : "MED",
      symbol: SYMBOL,
      side: "ASK",
      price: ask1.price,
      size: ask1.size,
      reason: { askMedian: askMed || null },
    });
  }
}

/* =========================
   Ingest (ticks/books)
========================= */
let seq = 0;

function onTrade({ ts, price, size, bid, ask, serial }) {
  const tick = {
    symbol: SYMBOL,
    ts,
    price,
    size,
    bid,
    ask,
    seq: serial ?? (++seq),
  };
  tick.side = inferSideFromBook(price);
  state.last = tick;
  updateBar5m(tick);
  broadcast({ type: "tick", ...tick });
  detectWhaleOnTrade(tick);
}

function onBook({ ts, bids, asks }) {
  state.book = { ts, bids, asks };
  broadcast({ type: "book", symbol: SYMBOL, ts, bids, asks });
  detectBookWall(state.book);
}

/* =========================
   Quote source: Fugle
========================= */
async function startFugle() {
  const apiKey = process.env.FUGLE_API_KEY;
  if (!apiKey) {
    console.error("Missing FUGLE_API_KEY. Fallback to mock.");
    startMock();
    return;
  }
  const { WebSocketClient } = require("@fugle/marketdata"); // per Fugle docs
  const client = new WebSocketClient({ apiKey });
  const stock = client.stock;

  stock.on("message", (message) => {
    let payload;
    try { payload = JSON.parse(message); } catch { return; }

    if (payload.event !== "data" || !payload.data) return;

    const ch = payload.channel;
    const d = payload.data;

    // Fugle timestamps are in microseconds in examples (time: 1685338200000000)
    const ts = d.time ? Math.floor(d.time / 1000) : nowMs();

    if (ch === "trades") {
      // size = 單量
      onTrade({
        ts,
        price: d.price,
        size: d.size,
        bid: d.bid,
        ask: d.ask,
        serial: d.serial,
      });
    } else if (ch === "books") {
      onBook({
        ts,
        bids: (d.bids || []).map(x => ({ price: x.price, size: x.size })),
        asks: (d.asks || []).map(x => ({ price: x.price, size: x.size })),
      });
    }
  });

  stock.on("error", (err) => console.error("Fugle error:", err?.message || err));
  stock.on("disconnect", (code, msg) => console.error("Fugle disconnect:", code, msg));

  await stock.connect();
  // Subscribe trades + books for whale detection
  stock.subscribe({ channel: "trades", symbol: SYMBOL });
  stock.subscribe({ channel: "books", symbol: SYMBOL });

  console.log("Fugle connected. Subscribed:", SYMBOL);
}

/* =========================
   Quote source: Mock (for dev)
========================= */
let mockTimer = null;
function startMock() {
  let px = 110.0;
  mockTimer = setInterval(() => {
    // 0~3 trades per 300ms
    const n = Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      px += (Math.random() - 0.5) * 0.15;
      px = Math.round(px * 100) / 100;
      const size = Math.floor(Math.random() * 60) + 1;

      // mock a simplistic book around price
      const bid1 = Math.round((px - 0.05) * 100) / 100;
      const ask1 = Math.round((px + 0.05) * 100) / 100;
      onBook({
        ts: nowMs(),
        bids: [
          { price: bid1, size: Math.floor(Math.random() * 5000) + 50 },
          { price: Math.round((bid1 - 0.05) * 100) / 100, size: Math.floor(Math.random() * 3000) + 50 },
        ],
        asks: [
          { price: ask1, size: Math.floor(Math.random() * 5000) + 50 },
          { price: Math.round((ask1 + 0.05) * 100) / 100, size: Math.floor(Math.random() * 3000) + 50 },
        ],
      });

      onTrade({ ts: nowMs(), price: px, size });
    }
  }, 300);
  console.log("Mock feed started.");
}

/* =========================
   Web server + WS to UI
========================= */
const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/realtime/state", (req, res) => {
  const serverTs = nowMs();
  state.serverTs = serverTs;
  res.json({
    symbol: state.symbol,
    name: state.name,
    serverTs,
    last: state.last,
    staleMs: state.last ? (serverTs - state.last.ts) : null,
    book: state.book,
    bar5m: state.bar5m,
    bars5mClosed: state.bars5mClosed,
    signals: state.signals.slice(-50),
    source: QUOTE_SOURCE,
  });
});

app.get("/", (req, res) => {
  res.type("html").send(INDEX_HTML);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

// 1s snapshot to keep UI smooth (even if no trades that second)
setInterval(() => {
  const serverTs = nowMs();
  broadcast({
    type: "snapshot_1s",
    serverTs,
    last: state.last,
    staleMs: state.last ? (serverTs - state.last.ts) : null,
    bar5m: state.bar5m,
    book: state.book,
  });
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log("Server listening on port", PORT, "source=", QUOTE_SOURCE);
  try {
    if (QUOTE_SOURCE === "fugle") await startFugle();
    else startMock();
  } catch (e) {
    console.error("Start source failed, fallback to mock:", e?.message || e);
    startMock();
  }
});

/* =========================
   Minimal UI (no framework)
========================= */
const INDEX_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${NAME} ${SYMBOL} 即時看盤（真用版）</title>
  <style>
    :root{--bg:#0b1020; --card:#111a33; --text:#e8eefc; --muted:#9fb0d2; --line:#223058; --good:#22c55e; --bad:#ef4444; --warn:#f59e0b;}
    *{box-sizing:border-box}
    body{margin:0;background:linear-gradient(180deg,#070b16 0%, #0b1020 40%, #0b1020 100%);color:var(--text);font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans TC", Arial;}
    .wrap{max-width:1100px;margin:0 auto;padding:18px}
    .row{display:grid;grid-template-columns:1.2fr 1fr;gap:14px}
    @media (max-width: 900px){.row{ /**< fix**/ grid-template-columns:1fr}}
    .card{background:rgba(17,26,51,.86);border:1px solid rgba(34,48,88,.65);border-radius:16px;padding:14px;box-shadow:0 10px 30px rgba(0,0,0,.25);}
    .top{display:flex;align-items:flex-end;justify-content:space-between;gap:12px}
    .title{font-size:22px;font-weight:700;letter-spacing:.3px}
    .sub{color:var(--muted);font-size:12px;margin-top:4px}
    .price{font-size:44px;font-weight:800;line-height:1}
    .pill{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;font-size:12px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04);color:var(--muted)}
    .dot{width:7px;height:7px;border-radius:99px;background:var(--good);display:inline-block}
    .dot.bad{background:var(--bad)}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
    .k{color:var(--muted);font-size:12px}
    .v{font-size:14px;font-weight:700;margin-top:4px}
    .mono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;}
    table{width:100%;border-collapse:collapse;margin-top:10px}
    th,td{padding:8px 8px;border-bottom:1px solid rgba(34,48,88,.6);text-align:right;font-size:12px}
    th{color:var(--muted);font-weight:600}
    td:first-child, th:first-child{text-align:left}
    .sig{display:flex;justify-content:space-between;gap:10px}
    .sig .tag{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.1);color:var(--muted)}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <div class="title">${NAME} <span class="mono">${SYMBOL}</span> <span class="pill" id="sourcePill">來源：--</span></div>
        <div class="sub">WebSocket 跳價・5 分 K（tick 聚合）・大戶單偵測（trade + book）</div>
      </div>
      <div class="pill"><span id="statusDot" class="dot"></span> <span id="statusText">連線中</span></div>
    </div>

    <div class="row" style="margin-top:14px;">
      <div class="card">
        <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:10px;">
          <div>
            <div class="k">即時價（以最新成交為準）</div>
            <div class="price mono" id="price">--</div>
            <div class="k" style="margin-top:6px">最後成交量：<span class="mono" id="size">--</span>　延遲：<span class="mono" id="stale">--</span>ms</div>
          </div>
          <div style="min-width:280px;">
            <div class="k">當根 5 分 K（in-progress）</div>
            <div class="grid2">
              <div><div class="k">O</div><div class="v mono" id="o">--</div></div>
              <div><div class="k">H</div><div class="v mono" id="h">--</div></div>
              <div><div class="k">L</div><div class="v mono" id="l">--</div></div>
              <div><div class="k">C</div><div class="v mono" id="c">--</div></div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="k">大戶單 / 牆 / 異常（最新 20）</div>
        <table>
          <thead><tr><th>時間</th><th>類型</th><th>方向</th><th>價</th><th>量</th></tr></thead>
          <tbody id="signals"></tbody>
        </table>
      </div>
    </div>
  </div>

<script>
  const priceEl = document.getElementById("price");
  const sizeEl = document.getElementById("size");
  const staleEl = document.getElementById("stale");
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const sourcePill = document.getElementById("sourcePill");
  const sigBody = document.getElementById("signals");

  function setStatus(ok, text){
    if(ok){ statusDot.className="dot"; statusText.textContent=text||"連線中"; }
    else { statusDot.className="dot bad"; statusText.textContent=text||"資料延遲"; }
  }
  function fmtTime(ms){
    const d=new Date(ms);
    const hh=String(d.getHours()).padStart(2,'0');
    const mm=String(d.getMinutes()).padStart(2,'0');
    const ss=String(d.getSeconds()).padStart(2,'0');
    return \`\${hh}:\${mm}:\${ss}\`;
  }
  function renderSignals(rows){
    sigBody.innerHTML="";
    const data=(rows||[]).slice(-20).reverse();
    for(const s of data){
      const tr=document.createElement("tr");
      tr.innerHTML=\`
        <td class="mono">\${fmtTime(s.ts||Date.now())}</td>
        <td class="mono">\${s.kind}</td>
        <td class="mono">\${s.side||""}</td>
        <td class="mono">\${(s.price??"").toString()}</td>
        <td class="mono">\${(s.size??"").toString()}</td>\`;
      sigBody.appendChild(tr);
    }
  }
  function applySnapshot(s){
    if(s.source) sourcePill.textContent = "來源：" + s.source;
    if(!s.last){ setStatus(false,"等待成交"); return; }
    const now=Date.now();
    const stale = (s.staleMs!=null)? s.staleMs : (now - s.last.ts);
    setStatus(stale <= 3000, stale <= 3000 ? "連線中" : "資料延遲");
    priceEl.textContent = Number(s.last.price).toFixed(2);
    sizeEl.textContent = s.last.size ?? "--";
    staleEl.textContent = stale;
    if(s.bar5m){
      document.getElementById("o").textContent = Number(s.bar5m.open).toFixed(2);
      document.getElementById("h").textContent = Number(s.bar5m.high).toFixed(2);
      document.getElementById("l").textContent = Number(s.bar5m.low).toFixed(2);
      document.getElementById("c").textContent = Number(s.bar5m.close).toFixed(2);
    }
    if(s.signals) renderSignals(s.signals);
  }

  // initial fetch
  fetch("/api/realtime/state",{cache:"no-store"}).then(r=>r.json()).then(applySnapshot).catch(()=>setStatus(false,"連線失敗"));

  // ws
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(\`\${proto}://\${location.host}\`);
  ws.onopen = ()=>{};
  ws.onmessage = (ev)=>{
    const m = JSON.parse(ev.data);
    if(m.type==="snapshot_1s"){
      applySnapshot({ ...m, source: sourcePill.textContent.replace("來源：","") });
    } else if(m.type==="tick"){
      // immediate price update
      applySnapshot({ last: m, staleMs: 0, bar5m: null, signals: null });
    } else if(m.type==="signal"){
      // append and re-render quickly: fetch latest 50 from server might be heavy; keep minimal
      fetch("/api/realtime/state",{cache:"no-store"}).then(r=>r.json()).then(s=>renderSignals(s.signals)).catch(()=>{});
    }
  };
  ws.onclose = ()=>setStatus(false,"WS 斷線");
</script>
</body>
</html>`;
