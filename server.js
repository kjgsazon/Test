const express = require("express");
const cors = require("cors");

const DEFAULT_SYMBOL = "2317";
const DEFAULT_NAME = "鴻海";
const BASE_PRICE = 110;
const VOL = 0.35;

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
      symbols.forEach(symbol => {
        const t = now / 1000;
        const drift = Math.sin((t / 30) + this.phase) * 0.9;
        const noise = (Math.random() - 0.5) * VOL;
        const price = BASE_PRICE + drift + noise;
        if (this.cb) this.cb({ ts: now, symbol, price: Number(price.toFixed(2)) });
      });
    }, 1000);
  }
  async stop() { if (this.timer) clearInterval(this.timer); }
}

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
      };
    } else {
      this.currentBar.high = Math.max(this.currentBar.high, tick.price);
      this.currentBar.low  = Math.min(this.currentBar.low, tick.price);
      this.currentBar.close = tick.price;
    }
    if (this.onUpdate && this.currentBar) this.onUpdate(this.currentBar);
  }
}

const realtimeState = {
  symbol: DEFAULT_SYMBOL,
  name: DEFAULT_NAME,
  lastQuote: null,
  currentBar5m: null,
  bars5mClosed: [],
  indicators: null,
  gateState: null,
  tradeState: null,
};

const provider = new QuoteProviderPoC();
const agg = new Bar5mAggregator();

provider.onTick((tick) => {
  realtimeState.lastQuote = tick;
  agg.handleTick(tick);
});

agg.onBarUpdate((bar) => { realtimeState.currentBar5m = bar; });

agg.onBarClose((bar) => {
  realtimeState.bars5mClosed.push(bar);
  if (realtimeState.bars5mClosed.length > 200) {
    realtimeState.bars5mClosed = realtimeState.bars5mClosed.slice(-200);
  }
});

provider.start([DEFAULT_SYMBOL]);

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/realtime/state", (req, res) => {
  res.json(realtimeState);
});

app.get("/", (req, res) => {
  res.type("html").send(INDEX_HTML);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server listening on port", PORT));

const INDEX_HTML = `
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${DEFAULT_NAME} ${DEFAULT_SYMBOL} 即時看盤（PoC）</title>
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
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <div class="title">${DEFAULT_NAME} <span class="mono">${DEFAULT_SYMBOL}</span> <span class="pill">PoC 模擬即時</span></div>
        <div class="sub">1 秒更新（UI）・5 分 K 收盤事件（bar-close）</div>
      </div>
      <div class="bar">
        <span class="pill"><span id="statusDot" class="dot"></span> <span id="statusText">連線中</span></span>
        <span class="pill">距離 5 分收盤：<span class="mono" id="countdown">--:--</span></span>
        <span class="pill">最後更新：<span class="mono" id="lastTs">--</span></span>
      </div>
    </div>

    <div class="row" style="margin-top:14px;">
      <div class="card">
        <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:10px;">
          <div>
            <div class="k">即時價</div>
            <div class="price mono" id="price">--</div>
            <div class="chg" id="chg"><span class="pill">漲跌：--</span> <span class="pill">漲跌幅：--</span></div>
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
            <tr><th>時間</th><th>O</th><th>H</th><th>L</th><th>C</th></tr>
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

  function countdownTo5m(nowMs){
    const FIVE_MIN = 5 * 60 * 1000;
    const next = (Math.floor(nowMs / FIVE_MIN) + 1) * FIVE_MIN;
    const diff = Math.max(0, next - nowMs);
    const m = String(Math.floor(diff / 60000)).padStart(2,'0');
    const s = String(Math.floor((diff % 60000)/1000)).padStart(2,'0');
    return \`\${m}:\${s}\`;
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
      tr.innerHTML = \`
        <td class="mono">\${hh}:\${mm}</td>
        <td class="mono">\${b.open.toFixed(2)}</td>
        <td class="mono">\${b.high.toFixed(2)}</td>
        <td class="mono">\${b.low.toFixed(2)}</td>
        <td class="mono">\${b.close.toFixed(2)}</td>\`;
      tbody.appendChild(tr);
    }
  }

  async function tick(){
    try{
      const r = await fetch(stateUrl, { cache: "no-store" });
      const s = await r.json();

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
          \`<span class="pill">漲跌： <span class="mono">\${sign}\${chg.toFixed(2)}</span></span>
           <span class="pill">漲跌幅： <span class="mono">\${sign}\${pct.toFixed(2)}%</span></span>\`;
      } else {
        document.getElementById("chg").innerHTML =
          \`<span class="pill">漲跌： --</span> <span class="pill">漲跌幅： --</span>\`;
      }

      if(s.currentBar5m){
        document.getElementById("o").textContent = s.currentBar5m.open.toFixed(2);
        document.getElementById("h").textContent = s.currentBar5m.high.toFixed(2);
        document.getElementById("l").textContent = s.currentBar5m.low.toFixed(2);
        document.getElementById("c").textContent = s.currentBar5m.close.toFixed(2);
      }

      const bars = (s.bars5mClosed || []).slice();
      if(s.currentBar5m) bars.push(s.currentBar5m);
      drawCandles(document.getElementById("chart"), bars);
      renderBarsTable(s.bars5mClosed || []);

    }catch(e){
      setStatus(false, "連線失敗");
    }
  }

  setInterval(tick, 1000);
  tick();
</script>
</body>
</html>
`;
