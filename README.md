# 2317 鴻海 Realtime PoC（Render-ready）

這是一個「看起來像看盤軟體」的 PoC：
- 1 秒更新（PoC 模擬價）
- 5 分 K 聚合（in-progress + close）
- 預設標的：2317 鴻海

> 注意：目前報價是 PoC 模擬。未來接正式即時行情，只需替換 QuoteProvider。

## 本機
```bash
npm install
npm run start
```
打開 http://localhost:3000


## 真用版：接 Fugle 即時行情 + 大戶單偵測（Trade + Book）

### 1) 本機跑（先用 mock）
```bash
npm install
npm run start
# 打開 http://localhost:3000
```

### 2) 換成 Fugle 即時行情（WebSocket）
依 Fugle WebSocket 文件，連線位置與驗證/訂閱方式如下：建立連線 `wss://api.fugle.tw/marketdata/v1.0/stock/streaming`，用 API Key auth，再訂閱 `trades` 與 `books` 頻道。  
（本專案已用 Fugle Node.js SDK `@fugle/marketdata` 實作）  

#### 設定環境變數
- `QUOTE_SOURCE=fugle`
- `FUGLE_API_KEY=你的key`
- `SYMBOL=2317`（可選，預設 2317）

Render 上可在 Environment / Secret 設定以上變數。

### 3) 大戶單偵測輸出
WebSocket 會推送：
- `tick`：逐筆成交（成交價/量）
- `book`：最佳五檔（bids/asks）
- `signal`：偵測到的大戶單/掛單牆

HTTP `GET /api/realtime/state` 也會回傳 `signals`（最近 50 筆）。
