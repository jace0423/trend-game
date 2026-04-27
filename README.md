# 趨勢回放 Trend Replay

純前端歷史股價回放遊戲。隨機選股、隨機開局日期，用 100 個交易日決勝負。

## 玩法

- 登入後在首頁選 **市場 / 起始資金 / 難度**，按進入系統開始
- 隨機挑一檔股票、隨機落在某個歷史日期
- 按 **下一步** (Space) 推進一天，**買進** (B) / **賣出** (S) 交易（支援零股 + 多空）
- 100 回合結束後結算，4 象限評價（賺賠 × 是否擊敗大盤）
- 結算頁可 **存這場 PDF** / **全部戰績 PDF**（兩種報表都直接下載，無對話框）

## 設定（登入頁）

| 項目 | 選項 |
|---|---|
| 市場 | 台股 NTD / 美股 USD（解鎖制） |
| 起始資金 | **100K（預設）** / 300K / 500K / 1M / 3M / 10M（依等級解鎖） |
| 難度 | 穩定（年化波動 < 30%）/ 高波動（≥ 30%）/ 多空切換（解鎖制） |
| K 線週期 | 日 / 周 / 月（OHLCV 聚合，遊戲中下拉切換） |
| 副圖指標 | KD(9,3,3) / RSI(14)（遊戲中下拉切換） |
| 交易成本 | 台股 0.1425% + 0.3% 證交稅（最低 NT$20）；美股 0% |
| 股數單位 | 兩市場皆零股（最小 1 股） |

## 等級解鎖系統

從 10 萬起步，依累積戰績與勝率（roi > 0 比例）逐步開放更高選項。每場結束自動檢查進度，登入頁底部顯示「下個解鎖」提示。

| 階 | 解鎖項目 | 條件 |
|---|---|---|
| 0 | 100K 起始 / 台股 / 穩定 | 預設 |
| 1 | 300K 起始 | 3 場 + 勝率 40% |
| 2 | 500K 起始 | 8 場 + 勝率 45% |
| 3 | 高波動難度 | 10 場 + 勝率 50% |
| 4 | 1M 起始 | 15 場 + 勝率 50% |
| 5 | 美股市場 | 20 場 + 勝率 55% |
| 6 | 多空切換難度 | 25 場 + 勝率 55% |
| 7 | 3M 起始 | 30 場 + 勝率 55% |
| 8 | 10M 起始 | 50 場 + 勝率 60% |

「清除紀錄」可重置該帳號的歷史戰績（解鎖會回到階 0）。

## 嚴重虧損保護（冷卻機制）

任一局結算 ROI ≤ -90% 觸發：

- ⏱ **1 小時帳號冷卻** — 進入系統按鈕鎖死，登入頁顯示大紅光暈倒數
- 🗑 **歷史戰績清空** — 該帳號 LS_HIST 整個刪除
- 💰 **強制回 100K** — 起始資金、市場、難度全部回最低階
- 🔒 **解鎖歸零** — 所有解鎖項目回到階 0

冷卻倒數視覺：36px Orbitron 紅光、紅→橘漸層進度條、2.4s 脈動發光。

## 結算判定（4 象限）

| 賺錢 (roi>0) | 擊敗大盤 (alpha>0) | 文字 | 顏色 |
|---|---|---|---|
| ✓ | ✓ | ✦ 完美擊敗市場 ✦ | win 青 |
| ✓ | ✗ | ✓ 賺錢但跑輸大盤 | mixed 黃 |
| ✗ | ✓ | △ 虧損但贏過大盤 | mixed 黃 |
| ✗ | ✗ | × 雙雙落敗 × | lose 紫 |
| 打平 | — | ━ 與市場打平 ━ | 無 |

「勝率」統計改以 **roi > 0**（實際賺錢）為準，不再以「擊敗大盤」為唯一判準。

### 結算自動平倉

100 天結束如還有持倉，自動以收盤價平倉（多單賣出 / 空單回補），扣除 fee + tax 後的淨損益計入交易紀錄。提早結束（按結束遊戲）也會偵測未平倉並彈窗確認。

### 單筆交易統計

結算頁顯示：
- 單筆勝率 = 賺錢的平倉次數 / 總平倉次數
- 平均 / 最佳 / 最差（占初始資金 %）
- 完整逐筆交易明細（買賣 + 股數 + 成交價 + 已實現損益）

## 報表（PDF）

兩種模式都用 `jsPDF + html2canvas` 直接下載，無瀏覽器列印對話框。

### 存這場 PDF
- 個股 + 期間 + 玩家
- 表格：起始 / 累計買進 / 累計賣出 / 最終結算（含 ROI）
- 條列每筆交易：日期 / 買賣 / 股數 / @ 價 / ($amt) / 損益

### 全部戰績 PDF
- 標題：玩家 · 全部戰績、總局數 / 總勝率 / 個股數
- 按個股分組
  - 標題：股票代號 · 名稱
  - 摘要：局數 / 勝率 / 平均 ROI / 最佳 ROI
  - 每場一個 block：右上最終總資產、報酬率、進出場價、單筆損益、逐筆交易表

Ctrl+P / 瀏覽器原生列印也會自動套用乾淨報表（透過 `beforeprint` 事件注入）。

## 資料

- **台股**：508 檔（TWSE 上市 + TPEX 上櫃，市值前段），10 年日 K
- **美股**：545 檔（S&P 500 + Nasdaq 100），10 年日 K
- **指數**：台指 / 日經 225 / Nasdaq 100，含日 K + 5 分 K（最近 60 天）
- 資料來源：Yahoo Finance（透過 `yfinance` 套件）
- 名稱對照：TWSE / TPEX 公開 OpenAPI（`data/tw_names.json`）

### 檔案格式

```jsonc
// data/prices/{id}.json
[{"t":"YYYY-MM-DD","o":..,"h":..,"l":..,"c":..,"v":..}, ...]

// data/stocks.json — catalog
[{"id":"2330.TW","name":"台積電","days":2448,"market":"TW",
  "minP":150.5,"maxP":2330.0,"lastP":2300.0,"vol":24.3}, ...]
```

ID 規則：
- TWSE 上市：`{code}.TW`（例：2330.TW）
- TPEX 上櫃：`{code}.TWO`（例：6488.TWO）
- 美股：`{ticker}`（例：AAPL）

成交量：TW 為「張」（÷ 1000）、US 為「股」。

## 本機啟動

```bash
python -m http.server 8080
# 開 http://localhost:8080
```

## 部署 GitHub Pages

1. push 到 GitHub
2. Settings → Pages → Source 選 `main` branch / root
3. 等一分鐘打開 `https://<user>.github.io/<repo>/`

## 重新爬取資料

需要 Python 3.10+，安裝套件：

```bash
pip install yfinance pandas requests
```

抓取主要股票（台股 + 美股 10 年日 K）：

```bash
python fetch_history.py                  # 全抓 (TW curated + US S&P500/Nasdaq100)
python fetch_history.py --markets tw     # 只抓台股
python fetch_history.py --markets us     # 只抓美股
python fetch_history.py --tw-all         # 加入全部 TWSE+TPEX 上市櫃 (~1965 檔)
python fetch_history.py --limit 5        # 測試用，只抓前 5 檔
python fetch_history.py --force          # 忽略快取，重新下載
python fetch_history.py --names-only     # 僅下載中文名稱對照表
python fetch_history.py --refresh-names  # 抓資料前先更新名稱對照表
```

抓取指數 5 分 K（2 年）：

```bash
python fetch_indices.py                  # 台指 / 日經 / Nasdaq 100
```

從現有檔案重建 catalog（不重抓）：

```bash
python rebuild_catalog.py
```

### 友善爬蟲設計

- 隨機間隔：每檔 1.5–3.5 秒
- 失敗指數退避：5 → 10 → 20 秒
- 增量恢復：已有完整資料的檔案會跳過（`--force` 強制重抓）
- 瀏覽器 User-Agent 避開預設攔截
- 強制 stdout utf-8（避免 Windows cp950 在中文/重音上崩潰）

### 速率上限參考（單 IP）

| 資料源 | 限額 | 適合場景 |
|---|---|---|
| yfinance | ~2000 req/hr | 主要來源（TW + US） |
| FinMind | 300/hr 未註冊；600/hr 免費 | 台股備援 |
| twstock | 嚴格，需 4-5s/req | 最後備援（TWSE 直接） |

## 技術棧

- 圖表：[lightweight-charts](https://github.com/tradingview/lightweight-charts) v4 (CDN)
- PDF：[jsPDF](https://github.com/parallax/jsPDF) + [html2canvas](https://html2canvas.hertzen.com/) (CDN)
- 純 HTML/CSS/JS，無 build step
- 主圖：K 線 + MA5/MA20/MA60 + 布林帶（白色虛線）
- 副圖：KD(9,3,3) 或 RSI(14)（下拉切換、與主圖時間軸同步）
- K 線週期：日/周/月（OHLCV 聚合）
- 爬蟲：Python + yfinance
- 個人戰績：localStorage（無伺服器）
- RWD：手機/桌機自適應
