
const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

/**
 * =========================
 * 設定
 * =========================
 */
const SYMBOL = (process.env.SYMBOL || "2317").toString();
const NAME_MAP = { "2317": "鴻海" };

const BIG_TRADE_MULT = Number(process.env.BIG_TRADE_MULT || 6);   // 大單成交：量/中位數倍數
const BOOK_WALL_MULT = Number(process.env.BOOK_WALL_MULT || 8);   // 掛單牆：一檔量/中位數倍數
const QUOTE_SOURCE = (process.env.QUOTE_SOURCE || "mock").toString(); // mock | vendor

/**
 * =========================
 * 狀態
 * =========================
 */
const state = {
  symbol: SYMBOL,
  name: NAME_MAP[SYMBOL] || SYMBOL,
  serverTs: null,

  // ✅ 逐筆成交（UI 價格只能用這個）
  last: null, // {ts, price, size, seq, side?}

  // ✅ 五檔（若上游有提供）
  book: null, // {ts, bid:[{p,s}], ask:[{p,s}]}

  // ✅ K 棒（由 tick 聚合）
  bar5m: null, // in-progress
  bars5mClosed: [],

  // ✅ 訊號（大戶單 / 掛單牆）
  signals: [], // newest first, max 50
};

/**
 * =========================
 * 小工具：滑動中位數（用來做相對倍數偵測）
 * =========================
 */
class RollingMedian {
  constructor(maxLen = 200) {
    this.maxLen = maxLen;
    this.arr = [];
  }
  push(x) {
    if (!Number.isFinite(x)) return;
    this.arr.push(x);
    if (this.arr.length > this.maxLen) this.arr.shift();
  }
  median() {
    if (this.arr.length === 0) return null;
    const a = [...this.arr].sort((p, q) => p - q);
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }
}

const tradeSizeMed = new RollingMedian(200);
const bidWallMed = new RollingMedian(200);
const askWallMed = new RollingMedian(200);

/**
 * =========================
 * Tick → 5 分 K 聚合
 * =========================
 */
const FIVE_MIN = 5 * 60 * 1000;
const floor5m = (ts) => Math.floor(ts / FIVE_MIN) * FIVE_MIN;

function pushSignal(sig) {
  state.signals.unshift(sig);
  if (state.signals.length > 50) state.signals.pop();
  broadcast({ type: "signal", ...sig });
}

function updateBarsFromTick(tick) {
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
    state.bar5m.low = Math.min(state.bar5m.low, tick.price);
    state.bar5m.close = tick.price;
    state.bar5m.volume += tick.size || 0;
  }
}

function inferSideFromBook(price, book) {
  // 只用最佳一檔推估方向：>= ask1 => BUY；<= bid1 => SELL；中間 => MID
  if (!book || !book.bid?.length || !book.ask?.length) return "UNK";
  const bid1 = book.bid[0]?.p;
  const ask1 = book.ask[0]?.p;
  if (!Number.isFinite(bid1) || !Number.isFinite(ask1)) return "UNK";
  if (price >= ask1) return "BUY";
  if (price <= bid1) return "SELL";
  return "MID";
}

function onTrade(tick) {
  // tick: {ts, price, size, seq}
  state.last = tick;
  updateBarsFromTick(tick);

  const size = Number(tick.size || 0);
  tradeSizeMed.push(size);

  const med = tradeSizeMed.median();
  if (med && med > 0 && size >= med * BIG_TRADE_MULT) {
    const side = inferSideFromBook(tick.price, state.book);
    pushSignal({
      ts: tick.ts,
      symbol: state.symbol,
      kind: "BIG_TRADE",
      side,
      price: tick.price,
      size,
      score: Number((size / med).toFixed(2)),
      note: `成交量=${size}，約為近200筆中位數(${med})的 ${Number((size/med).toFixed(2))} 倍`,
    });
  }

  broadcast({ type: "tick", ...tick });
}

function onBook(book) {
  // book: {ts, bid:[{p,s}], ask:[{p,s}]}
  state.book = book;

  const bid1s = Number(book.bid?.[0]?.s || 0);
  const ask1s = Number(book.ask?.[0]?.s || 0);

  bidWallMed.push(bid1s);
  askWallMed.push(ask1s);

  const bidMed = bidWallMed.median();
  const askMed = askWallMed.median();

  if (bidMed && bidMed > 0 && bid1s >= bidMed * BOOK_WALL_MULT) {
    pushSignal({
      ts: book.ts,
      symbol: state.symbol,
      kind: "BOOK_WALL",
      side: "BID",
      price: book.bid?.[0]?.p,
      size: bid1s,
      score: Number((bid1s / bidMed).toFixed(2)),
      note: `買一掛單量=${bid1s}，約為近200筆中位數(${bidMed})的 ${Number((bid1s/bidMed).toFixed(2))} 倍`,
    });
  }
  if (askMed && askMed > 0 && ask1s >= askMed * BOOK_WALL_MULT) {
    pushSignal({
      ts: book.ts,
      symbol: state.symbol,
      kind: "BOOK_WALL",
      side: "ASK",
      price: book.ask?.[0]?.p,
      size: ask1s,
      score: Number((ask1s / askMed).toFixed(2)),
      note: `賣一掛單量=${ask1s}，約為近200筆中位數(${askMed})的 ${Number((ask1s/askMed).toFixed(2))} 倍`,
    });
  }

  broadcast({ type: "book", ...book });
}

/**
 * =========================
 * Adapter（行情來源）
 *  - 你現在券商是「國泰證券」，但多數券商「不提供公開行情 WebSocket」給自建系統。
 *  - 真用通常是：使用合法授權行情商（LV1/LV2）→ 接進來。
 *  - 這裡先保留 vendor adapter 的插槽；你拿到廠商文件後，只要改 startVendorAdapter()。
 * =========================
 */
function startMockAdapter() {
  let seq = 0;
  let px = 110.0;

  // 模擬五檔：讓 BOOK_WALL 偵測能動
  function makeBook(ts, mid) {
    const bid = [
      { p: Number((mid - 0.05).toFixed(2)), s: Math.floor(Math.random() * 200) + 50 },
      { p: Number((mid - 0.10).toFixed(2)), s: Math.floor(Math.random() * 180) + 40 },
      { p: Number((mid - 0.15).toFixed(2)), s: Math.floor(Math.random() * 160) + 30 },
      { p: Number((mid - 0.20).toFixed(2)), s: Math.floor(Math.random() * 140) + 20 },
      { p: Number((mid - 0.25).toFixed(2)), s: Math.floor(Math.random() * 120) + 10 },
    ];
    const ask = [
      { p: Number((mid + 0.05).toFixed(2)), s: Math.floor(Math.random() * 200) + 50 },
      { p: Number((mid + 0.10).toFixed(2)), s: Math.floor(Math.random() * 180) + 40 },
      { p: Number((mid + 0.15).toFixed(2)), s: Math.floor(Math.random() * 160) + 30 },
      { p: Number((mid + 0.20).toFixed(2)), s: Math.floor(Math.random() * 140) + 20 },
      { p: Number((mid + 0.25).toFixed(2)), s: Math.floor(Math.random() * 120) + 10 },
    ];

    // 偶爾製造「掛單牆」
    if (Math.random() < 0.03) bid[0].s *= 15;
    if (Math.random() < 0.03) ask[0].s *= 15;

    return { ts, bid, ask };
  }

  const timer = setInterval(() => {
    const ts = Date.now();

    // 0~4筆成交
    const n = Math.floor(Math.random() * 5);
    for (let i = 0; i < n; i++) {
      px += (Math.random() - 0.5) * 0.15;
      px = Math.round(px * 100) / 100;

      let size = Math.floor(Math.random() * 15) + 1;
      // 偶爾製造「大單成交」
      if (Math.random() < 0.04) size *= 30;

      onTrade({ symbol: SYMBOL, ts: Date.now(), price: px, size, seq: ++seq });
    }

    onBook(makeBook(ts, px));
  }, 250);

  return () => clearInterval(timer);
}

function startVendorAdapter() {
  // TODO: 把合法行情商的 WS/SSE 接進來（LV1: trades + book）
  // 你拿到廠商文件/連線方式後，我會把這段替換成真正的 adapter。
  console.warn("[vendor] adapter is not configured. Falling back to mock.");
  return startMockAdapter();
}

/**
 * =========================
 * Web / WS
 * =========================
 */
const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/realtime/state", (req, res) => {
  state.serverTs = Date.now();
  res.json({
    symbol: state.symbol,
    name: state.name,
    serverTs: state.serverTs,
    last: state.last,
    staleMs: state.last ? state.serverTs - state.last.ts : null,
    book: state.book,
    bar5m: state.bar5m,
    bars5mClosed: state.bars5mClosed,
    signals: state.signals,
  });
});

app.get("/", (req, res) => {
  res.type("html").send(INDEX_HTML);
});

const server = http.createServer(app);

// WebSocket upgrade: /ws/quotes
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url && req.url.startsWith("/ws/quotes")) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "hello", symbol: state.symbol, name: state.name }));
});

// 每秒 snapshot：讓 UI 像券商那樣「整體同步」
setInterval(() => {
  broadcast({
    type: "snapshot_1s",
    serverTs: Date.now(),
    last: state.last,
    book: state.book,
    bar5m: state.bar5m,
    signals: state.signals.slice(0, 10),
  });
}, 1000);

// 啟動行情來源
let stopFeed = null;
if (QUOTE_SOURCE === "vendor") stopFeed = startVendorAdapter();
else stopFeed = startMockAdapter();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on port", PORT));

/**
 * =========================
 * 前端（最小改動版）
 *  - 價格顯示只用 last.price
 *  - 顯示 signals（大戶單偵測）
 * =========================
 */
const INDEX_HTML = `
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${NAME_MAP[SYMBOL] || SYMBOL} ${SYMBOL} 即時看盤</title>
  <style>
    :root{--bg:#0b1020; --card:#111a33; --text:#e8eefc; --muted:#9fb0d2; --line:#223058; --good:#22c55e; --bad:#ef4444; --warn:#f59e0b;}
    *{box-sizing:border-box}
    body{margin:0;background:linear-gradient(180deg,#070b16 0%, #0b1020 40%, #0b1020 100%);color:var(--text);font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans TC", Arial;}
    .wrap{max-width:1180px;margin:0 auto;padding:18px}
    .row{display:grid;grid-template-columns:1.2fr 1fr;gap:14px}
    @media (max-width: 900px){.row{grid-template-columns:1fr}}
    .card{background:rgba(17,26,51,.86);border:1px solid rgba(34,48,88,.65);border-radius:16px;padding:14px;box-shadow:0 10px 30px rgba(0,0,0,.25);}
    .top{display:flex;align-items:flex-end;justify-content:space-between;gap:12px}
    .title{font-size:22px;font-weight:700;letter-spacing:.3px}
    .sub{color:var(--muted);font-size:12px;margin-top:4px}
    .price{font-size:44px;font-weight:800;line-height:1}
    .pill{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;font-size:12px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04);color:var(--muted)}
    .bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .dot{width:7px;height:7px;border-radius:99px;background:var(--good);display:inline-block}
    .dot.bad{background:var(--bad)}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
    .kv{border-top:1px solid rgba(34,48,88,.6);padding-top:10px}
    .k{color:var(--muted);font-size:12px}
    .v{font-size:14px;font-weight:700;margin-top:4px}
    .mono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;}
    table{width:100%;border-collapse:collapse;margin-top:10px}
    th,td{padding:8px 8px;border-bottom:1px solid rgba(34,48,88,.6);text-align:right;font-size:12px}
    th{color:var(--muted);font-weight:600}
    td:first-child, th:first-child{text-align:left}
    .sig{display:flex;flex-direction:column;gap:8px;margin-top:10px}
    .sigItem{border:1px solid rgba(34,48,88,.6);border-radius:12px;padding:10px;background:rgba(0,0,0,.12)}
    .sigTitle{display:flex;justify-content:space-between;gap:10px}
    .tag{font-size:11px;padding:4px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04);color:var(--muted)}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <div class="title"><span id="name"></span> <span class="mono" id="symbol"></span> <span class="pill">${QUOTE_SOURCE === "mock" ? "Mock 行情" : "Vendor 行情"}</span></div>
        <div class="sub">逐筆成交（tick）・五檔（book）・5 分 K（tick 聚合）・大戶偵測（signals）</div>
      </div>
      <div class="bar">
        <span class="pill"><span id="statusDot" class="dot"></span> <span id="statusText">連線中</span></span>
        <span class="pill">最後更新：<span class="mono" id="lastTs">--</span></span>
        <span class="pill">stale：<span class="mono" id="stale">--</span></span>
      </div>
    </div>

    <div class="row" style="margin-top:14px;">
      <div class="card">
        <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:10px;">
          <div>
            <div class="k">即時價（只用 last.price）</div>
            <div class="price mono" id="price">--</div>
          </div>
          <div class="kv" style="min-width:300px;">
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
          <div class="k">大戶/掛單牆偵測（最近 10 筆）</div>
          <div class="sig" id="signals"></div>
          <div class="k" style="margin-top:12px;">提示：真實「大戶單」需搭配合法即時行情（最好含五檔/逐筆），券商 App 的顯示不等於公開 API。</div>
        </div>
      </div>

      <div class="card">
        <div class="k">最近 30 根已收盤 5 分 K</div>
        <table>
          <thead>
            <tr><th>時間</th><th>O</th><th>H</th><th>L</th><th>C</th><th>V</th></tr>
          </thead>
          <tbody id="bars"></tbody>
        </table>
      </div>
    </div>
  </div>

<script>
  const stateUrl = "/api/realtime/state";

  function fmtTs(ms){
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2,'0');
    const mm = String(d.getMinutes()).padStart(2,'0');
    const ss = String(d.getSeconds()).padStart(2,'0');
    return \`\${hh}:\${mm}:\${ss}\`;
  }
  function setStatus(ok, warnText){
    const dot = document.getElementById("statusDot");
    const text = document.getElementById("statusText");
    if(ok){ dot.className = "dot"; text.textContent = "連線中"; }
    else { dot.className = "dot bad"; text.textContent = warnText || "資料延遲"; }
  }

  function renderBarsTable(bars){
    const tbody = document.getElementById("bars");
    tbody.innerHTML = "";
    const data = (bars||[]).slice(-30).reverse();
    for(const b of data){
      const t = new Date(b.startTs);
      const hh = String(t.getHours()).padStart(2,'0');
      const mm = String(t.getMinutes()).padStart(2,'0');
      const tr = document.createElement("tr");
      tr.innerHTML = \`
        <td class="mono">\${hh}:\${mm}</td>
        <td class="mono">\${b.open.toFixed(2)}</td>
        <td class="mono">\${b.high.toFixed(2)}</td>
        <td class="mono">\${b.low.toFixed(2)}</td>
        <td class="mono">\${b.close.toFixed(2)}</td>
        <td class="mono">\${(b.volume||0)}</td>\`;
      tbody.appendChild(tr);
    }
  }

  function renderSignals(sigs){
    const box = document.getElementById("signals");
    box.innerHTML = "";
    const data = (sigs||[]).slice(0,10);
    if(data.length === 0){
      box.innerHTML = '<div class="k">尚無訊號</div>';
      return;
    }
    for(const s of data){
      const div = document.createElement("div");
      div.className = "sigItem";
      div.innerHTML = \`
        <div class="sigTitle">
          <div>
            <span class="tag">\${s.kind}</span>
            <span class="tag">\${s.side}</span>
            <span class="mono">\${fmtTs(s.ts)}</span>
          </div>
          <div class="mono">score \${s.score}</div>
        </div>
        <div class="k">\${s.note || ""}</div>
        <div class="mono">P \${Number(s.price||0).toFixed(2)} · S \${s.size||0}</div>
      \`;
      box.appendChild(div);
    }
  }

  async function refresh(){
    try{
      const r = await fetch(stateUrl, { cache: "no-store" });
      const s = await r.json();

      document.getElementById("name").textContent = s.name;
      document.getElementById("symbol").textContent = s.symbol;

      if(!s.last){
        setStatus(false, "等待資料");
        return;
      }
      const now = Date.now();
      const age = now - s.last.ts;
      setStatus(age <= 3000, age <= 3000 ? "" : "資料延遲");

      document.getElementById("lastTs").textContent = fmtTs(s.last.ts);
      document.getElementById("stale").textContent = (s.staleMs == null) ? "--" : (s.staleMs + "ms");
      document.getElementById("price").textContent = Number(s.last.price).toFixed(2);

      if(s.bar5m){
        document.getElementById("o").textContent = Number(s.bar5m.open).toFixed(2);
        document.getElementById("h").textContent = Number(s.bar5m.high).toFixed(2);
        document.getElementById("l").textContent = Number(s.bar5m.low).toFixed(2);
        document.getElementById("c").textContent = Number(s.bar5m.close).toFixed(2);
      }

      renderBarsTable(s.bars5mClosed || []);
      renderSignals(s.signals || []);
    }catch(e){
      setStatus(false, "連線失敗");
    }
  }

  // WS：更像券商（tick/信號即推）
  (function connectWS(){
    try{
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(\`\${proto}://\${location.host}/ws/quotes?symbol=${SYMBOL}\`);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if(msg.type === "tick"){
          document.getElementById("price").textContent = Number(msg.price).toFixed(2);
          document.getElementById("lastTs").textContent = fmtTs(msg.ts);
        }
        if(msg.type === "signal"){
          refresh();
        }
      };
      ws.onclose = () => setTimeout(connectWS, 1000);
    }catch(e){
      // fallback to polling
    }
  })();

  setInterval(refresh, 1000);
  refresh();
</script>
</body>
</html>
`;
