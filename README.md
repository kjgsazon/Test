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


## 真用版本（逐筆 + WebSocket + 大戶單偵測）

- HTTP: `GET /api/realtime/state?symbol=2317`
- WS: `ws://<host>/ws/quotes?symbol=2317`
  - `type: tick`：逐筆成交
  - `type: snapshot_1s`：每秒狀態同步
  - `type: signal`：大戶單偵測事件

### 環境變數
- `QUOTE_SOURCE=mock`（預設，模擬逐筆/五檔）
- `QUOTE_SOURCE=vendor`（自行接合法行情商；範例見 `server.js` 的 Adapter 區塊）
- `SYMBOL=2317`
- `BIG_TRADE_MULT=6`（大單成交：量/中位數倍數）
- `BOOK_WALL_MULT=8`（掛單牆：量/中位數倍數）

> 備註：國泰證券本身若未提供「開放行情 API」，仍需使用合法授權的行情商資料源（LV1/LV2）。
