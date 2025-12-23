# 台股看盤 PoC（多標的 + 每日分析 + 匯出）

這是一個**不依賴 TradingView** 的最小可跑 PoC：

- **多標的切換**（內建：2317 鴻海、2330 台積電）
- **1 秒 UI 更新**（目前資料為 *PoC 模擬*，方便先把系統跑起來）
- **5 分 K 聚合**（bar-close 事件）
- **每日分析（同頁同時輸出）**
  - 隔日沖風險（HIGH / MEDIUM / LOW）
  - 趨勢狀態（BULLISH / RANGE / WEAKENING）
  - 結構變化（STRENGTHEN / WEAKEN / NONE）
- **醒目警示**：結構轉強/轉弱會在頁面上方以綠/紅 banner 顯示
- **可匯出報告**：TXT / MD 一鍵下載

> ⚠️ 目前報價與成交量為 PoC 模擬。你之後找到行情商後，只要替換 `QuoteProviderPoC`，整套分析與前端都可沿用。

## 本機執行

```bash
npm install
npm start
```

開啟：`http://localhost:3000`

## API

- `GET /api/symbols`
- `GET /api/realtime/state?symbol=2317`
- `GET /api/daily-analysis?symbol=2317`
- `GET /api/daily-analysis/export?symbol=2317&format=txt`
- `GET /api/daily-analysis/export?symbol=2317&format=md`

## 部署（Render）

已附 `render.yaml`，直接用 Render 建立 Web Service 即可。
