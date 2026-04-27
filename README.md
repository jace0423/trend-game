# 趨勢回放 Trend Replay

純前端歷史股價回放遊戲。隨機選股、隨機開局日期，用 100 個交易日決勝負。

## 玩法

- 登入後在首頁選 **市場 / 起始資金 / 難度**，按進入系統開始
- 隨機挑一檔股票、隨機落在某個歷史日期
- 按 **下一步** (Space) 推進一天，**買進** (B) / **賣出** (S) 交易（支援零股 + 多空）
- 100 回合結束後結算，4 象限評價（賺賠 × 是否擊敗大盤）
- 結算頁可 **複製戰績** 或 **列印 / 存成 PDF**

## 設定（登入頁）

| 項目 | 選項 |
|---|---|
| 市場 | 台股 NTD / 美股 USD |
| 起始資金 | 100K / 300K / 500K（預設） / 1M / 3M / 10M |
| 難度 | 穩定（年化波動 < 30%）/ 高波動（≥ 30%）/ 多空切換 |
| 副圖指標 | KD(9,3,3) / RSI(14)（遊戲中下拉切換） |
| 交易成本 | 台股 0.1425% + 0.3% 證交稅（最低 NT$20）；美股 0% |
| 股數單位 | 兩市場皆零股（最小 1 股） |

## 資料

- **台股**：508 檔（TWSE 上市 + TPEX 上櫃，市值/成交量前段），10 年日 K
- **美股**：~520 檔（S&P 500 + Nasdaq 100 去重），10 年日 K
- **指數**：台指 / 日經 225 / Nasdaq 100，含日 K + 5 分 K
- 資料來源：Yahoo Finance（透過 `yfinance` 套件）
- 名稱對照：TWSE / TPEX 公開 OpenAPI（`data/tw_names.json`）

### 檔案格式

```json
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
python fetch_history.py                  # 全抓 (TW curated 182 + US Wikipedia)
python fetch_history.py --markets tw     # 只抓台股
python fetch_history.py --markets us     # 只抓美股
python fetch_history.py --tw-all         # 加入全部 TWSE+TPEX 上市櫃
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
- 純 HTML/CSS/JS，無 build step
- 主圖：K 線 + MA5/MA20/MA60 + 布林帶
- 副圖：KD(9,3,3) 或 RSI(14)（下拉切換）
- 爬蟲：Python + yfinance
- 個人戰績：localStorage（無伺服器）
