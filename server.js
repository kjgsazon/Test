const express = require("express");
const cors = require("cors");

class QuoteProviderPoC {
  constructor() { this.timer = null; this.cb = null; }
  onTick(cb) { this.cb = cb; }
  async start(symbols) {
    this.timer = setInterval(() => {
      symbols.forEach(symbol => {
        const mockPrice = 100 + Math.sin(Date.now() / 5000) * 2 + Math.random() * 0.2;
        if (this.cb) this.cb({ ts: Date.now(), symbol, price: Number(mockPrice.toFixed(2)) });
      });
    }, 1000);
  }
  async stop() { if (this.timer) clearInterval(this.timer); }
}

class Bar5mAggregator {
  constructor() { this.currentBar = null; this.onUpdate = null; this.onClose = null; }
  onBarUpdate(cb) { this.onUpdate = cb; }
  onBarClose(cb) { this.onClose = cb; }
  handleTick(tick) {
    const FIVE_MIN = 5 * 60 * 1000;
    const barStart = Math.floor(tick.ts / FIVE_MIN) * FIVE_MIN;

    if (!this.currentBar || this.currentBar.startTs !== barStart) {
      if (this.currentBar && this.onClose) this.onClose(this.currentBar);
      this.currentBar = { startTs: barStart, open: tick.price, high: tick.price, low: tick.price, close: tick.price };
    } else {
      this.currentBar.high = Math.max(this.currentBar.high, tick.price);
      this.currentBar.low  = Math.min(this.currentBar.low, tick.price);
      this.currentBar.close = tick.price;
    }
    if (this.onUpdate && this.currentBar) this.onUpdate(this.currentBar);
  }
}

const realtimeState = {
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

provider.start(["2330"]);

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.type("html").send(`
  <html>
    <head><meta charset="utf-8"/><title>Realtime PoC</title></head>
    <body style="font-family: sans-serif;">
      <h2>Realtime PoC（1 秒更新 / 5 分 K）</h2>
      <p>API: <a href="/api/realtime/state" target="_blank">/api/realtime/state</a></p>
      <pre id="out">loading...</pre>
      <script>
        async function tick(){
          const r = await fetch('/api/realtime/state');
          const j = await r.json();
          document.getElementById('out').textContent = JSON.stringify(j, null, 2);
        }
        setInterval(tick, 1000);
        tick();
      </script>
    </body>
  </html>
  `);
});

app.get("/api/realtime/state", (req, res) => { res.json(realtimeState); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server listening on port", PORT));
