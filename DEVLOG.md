# 開發日誌 · DEVLOG

從 50 檔台股小品 → 1053 檔多市場交易模擬器的演進記錄。

## 階段 1 — 資料擴充與爬蟲（2026-04-27）

### 起點
- 原始：50 檔台股 × ~495 天（2024-04 → 2026-04）
- 來源：本機 SQLite (`Investor-Calendar/db`)，現已不可用

### 目標
- 擴充到 10 年日 K
- 加入美股
- 友善爬取避免被鎖

### 結果
| 類別 | 檔數 | 範圍 |
|---|---|---|
| 台股上市 (.TW) | 445 | 2016-03 → 2026-04 |
| 台股上櫃 (.TWO) | 63 | 2016-03 → 2026-04 |
| 美股 | 545 | 2016-03 → 2026-04 |
| 指數（台指/日經/Nasdaq） | 6 個檔案 | 1d + 5m |
| **合計** | **1053 檔** | ~136 MB |

### 建立的腳本
- `fetch_history.py` — yfinance 友善爬蟲（隨機 1.5–3.5s 間隔、3 次指數退避）
  - `--markets tw,us` / `--tw-all` / `--limit N` / `--force` / `--names-only` / `--refresh-names`
- `fetch_indices.py` — 指數 1d + 5m（分塊抓 60 天）
- `rebuild_catalog.py` — 從 data/prices/ 重建 stocks.json
- `data/tw_names.json` — TWSE + TPEX OpenAPI 中文對照表

### 解決的坑
- `urllib.error.HTTPError: 403` — Wikipedia 擋預設 Python UA → 加 Chrome UA
- `UnicodeEncodeError: cp950` — Windows console 不能印中文/重音 → `sys.stdout.reconfigure(encoding="utf-8")`
- `0 rows for 6488.TW` — 上櫃股票需要 `.TWO` 後綴 → directory 帶上 suffix
- TPEX OpenAPI 用英文 key（`SecuritiesCompanyCode` / `CompanyAbbreviation`），TWSE 用中文 → 分別處理

### 速率限制參考
| 來源 | 限額 | 備註 |
|---|---|---|
| yfinance | ~2000 req/hr | 主要來源 |
| FinMind | 300/hr unauth；600/hr 免費 | 備援 |
| twstock | 嚴格 4-5s/req | 最後備援 |

---

## 階段 2 — 遊戲玩法重構

### 設定畫面（登入頁）
- 加入市場下拉（台股 NTD / 美股 USD）
- 加入起始資金下拉（100K / 300K / 500K / 1M / 3M / 10M）
- 加入難度切換（穩定 / 高波動 / 多空）
- 加入即時「可玩股票池：N / M 檔」提示

### 零股交易
- TW 從 1000 股 lot 改為 1 股（零股）
- 與 US 一致

### 交易成本重構
- TW：0.1425% 手續費（最低 NT$20）+ 0.3% 證交稅
- US：零佣金、零稅
- 動態 `currentCosts()` getter 依市場切換

### 等級解鎖系統
- 從 100K + 台股 + 穩定 起步
- 8 階解鎖（300K → 500K → 高波動 → 1M → 美股 → 多空 → 3M → 10M）
- 條件：累積局數 + 勝率（roi > 0）達標
- 鎖定選項顯示 🔒 + disable
- 登入頁顯示「下個解鎖」進度提示
- 局結束自動 re-apply unlocks

---

## 階段 3 — 結算判定改革

### 4 象限判定（取代「擊敗大盤 = 唯一勝負」）
| 賺錢 | 擊敗大盤 | 判定 |
|---|---|---|
| ✓ | ✓ | ✦ 完美擊敗市場 ✦ |
| ✓ | ✗ | ✓ 賺錢但跑輸大盤（中性） |
| ✗ | ✓ | △ 虧損但贏過大盤（中性） |
| ✗ | ✗ | × 雙雙落敗 × |

修正了「賺錢但顯示失敗」的判讀盲點。勝率改以 `roi > 0` 計算。

### 結算自動平倉
- 100 天結束如還有持倉 → 以收盤價自動平倉
- 多單：cash += gross - fee - tax；pnl = (price - avg) * qty - fee - tax
- 空單：cash -= gross + fee；pnl = (avg - price) * qty - fee
- 解決「玩到 100 天但沒賣 → 單筆勝率/平均皆無資料」

### 提早結束防呆
- 按「結束遊戲」如有持倉，跳對話框：
  ```
  你還有 多單 1,000 股未平倉
  平均成本 27.52 / 現價 29.10
  未實現損益：+1,580
  ```
- 確認 → 自動平倉結算；取消 → 回去手動

### 嚴重虧損保護（冷卻機制）
ROI ≤ -90% 觸發：
- ⏱ 1 小時帳號冷卻
- 🗑 歷史戰績清空
- 💰 起始資金回 100K
- 🔒 解鎖歸零

冷卻倒數視覺：36px Orbitron 紅光、紅→橘漸層進度條、2.4s 脈動發光。

### 單筆交易統計
結算頁加：
- 單筆勝率（賺錢平倉次數 / 總平倉次數）
- 平均 / 最佳 / 最差（占初始資金 %）
- 完整逐筆交易明細（買賣 + 股數 + 成交價 + 已實現損益）

---

## 階段 4 — 圖表強化

### 副圖（KD / RSI）
- 主圖下方加副表（lightweight-charts 第二實例）
- 主圖 → 副圖時間軸單向同步（避免雙向訂閱迴圈）
- 下拉切換 KD(9,3,3) / RSI(14)
- 80/20 (KD) 或 70/30 (RSI) 參考線

### K 線週期
- 日 / 周 / 月切換（OHLCV 聚合）
- ISO 週為週一起點；月以 YYYY-MM 為 key
- MA / 布林 / KD / RSI 全套用聚合後 bars
- 日 K 模式 appendBar 增量更新（避免閃爍）；周/月 K 重畫但不 fitContent

### 視覺微調
- 布林帶顏色加深（rgba 0.5 → 0.85）便於辨識
- 移除登入頁/結算頁的 `//` 前綴

---

## 階段 5 — 報表（PDF）

### 技術棧
`jsPDF + html2canvas` CDN，直接下載無對話框。

### 存這場 PDF
- 個股 + 期間 + 玩家
- 表格：起始 / 累計買進 / 累計賣出 / 最終結算（含 ROI）
- 條列每筆交易：日期 / 買賣 / 股數 / @ 價 / ($amt) / 損益（紅綠標色）

### 全部戰績 PDF
- 標題：玩家 · 全部戰績、總局數 / 勝率 / 個股數
- 按個股分組
  - 標題：股票代號 · 名稱
  - 摘要：局數 / 勝率 / 平均 / 最佳 ROI
  - 每場 block：右上總資產、進出場價、單筆損益、逐筆交易表

### Ctrl+P / 原生列印同步
透過 `beforeprint` 事件注入乾淨報表 overlay，`afterprint` 移除。瀏覽器原生列印也走同一份報表。

---

## 階段 6 — 其他細節

### 內建瀏覽器警告
偵測 LINE / FB / IG / WeChat → 顯示警告 + 步驟指引。技術上**無法強制**跳轉外部瀏覽器（App 故意擋）。提供：
- 對應 App 的手動操作步驟
- 「複製網址」按鈕（含 `execCommand` fallback）
- 分享連結加 `?openExternalBrowser=1` 給 LINE 用戶從聊天點

### RWD
- 主 grid `minmax(0, 1fr) 320px` 防 chart-wrap 擠掉 panel
- 手機 chart-wrap 60vh / 主圖 min-height 240px / 副圖固定 110px
- enterGame 後 200ms 強制 chart.resize（防初始 0 高度）
- 結算頁 padding 50px 防 cyber-glitch text-shadow 被切

### 戰績輸出
- 「複製戰績」（純文字 ASCII 框）已移除（按使用者要求）
- 只保留 PDF（存這場 / 全部戰績）

---

## 部署

- repo：https://github.com/jace0423/trend-game
- pages：https://jace0423.github.io/trend-game/
- 推送方式：`git push origin2 main`（origin = jiarong0423，origin2 = jace0423）

## 技術棧總結

| 領域 | 工具 |
|---|---|
| 圖表 | lightweight-charts v4 (CDN) |
| PDF | jsPDF + html2canvas (CDN) |
| 字型 | Orbitron + Share Tech Mono (Google Fonts) |
| 資料 | yfinance + TWSE/TPEX OpenAPI |
| 後端 | 無（純前端 + localStorage） |
| 部署 | GitHub Pages |

## 未做但可加的

- Alpaca 接入（5m × 2y 美股）— 帳號設定卡 MFA 沒過
- 台指期（TXF）— yfinance 不支援，需 FinMind 付費或期交所 CSV
- 多空槓桿 > 2x（目前限 2x）
- 即時價格（純歷史回放，無 live data）
- 帳號雲端同步（純 localStorage）
- 排行榜（純單機）
