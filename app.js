const DEFAULT_INITIAL_CASH = 100_000;
const TOTAL_ROUNDS = 100;
const PRE_BARS = 60; // MA60 最少需求，讓短歷史股也能從中間開局

// 市場交易成本：TW 1.425‰ 手續費（最低 NT$20）+ 0.3% 證交稅；US 零佣金、零稅
// lot=1 — 零股交易，可買任意股數（最小單位 1 股）
const MARKET_COSTS = {
  TW: { fee: 0.001425, tax: 0.003, minFee: 20, lot: 1, currency: "NT$" },
  US: { fee: 0,        tax: 0,     minFee: 0,  lot: 1, currency: "$"   },
};
const LS_MARKET = "trend_market";
const LS_CASH = "trend_initial_cash";
const LS_DIFFICULTY = "trend_difficulty";
const LS_INDICATOR = "trend_indicator";
const LS_KPERIOD = "trend_kperiod";  // D / W / M

// 難度：依據年化波動度（vol，% 單位）與是否允許多空切換
const DIFFICULTY = {
  stable:   { label: "穩定",     volMin: 0,  volMax: 30, allowShort: false },
  volatile: { label: "高波動",   volMin: 30, volMax: 999, allowShort: false },
  hedge:    { label: "多空切換", volMin: 0,  volMax: 999, allowShort: true  },
};

// 等級解鎖：依玩家累積戰績逐步開放選項
// 條件 met = (games 已玩局數 >= minGames) && (勝率 >= minWinRate)
// 每個解鎖項目對應一個 lock-key，在 setup UI 上會 disable/hint 還沒解鎖的選項
const UNLOCKS = [
  { key: "cash:300000",  label: "300K 起始",    minGames: 3,  minWinRate: 0.40 },
  { key: "cash:500000",  label: "500K 起始",    minGames: 8,  minWinRate: 0.45 },
  { key: "diff:volatile",label: "高波動難度",   minGames: 10, minWinRate: 0.50 },
  { key: "cash:1000000", label: "1M 起始",      minGames: 15, minWinRate: 0.50 },
  { key: "market:US",    label: "美股市場",     minGames: 20, minWinRate: 0.55 },
  { key: "diff:hedge",   label: "多空切換難度", minGames: 25, minWinRate: 0.55 },
  { key: "cash:3000000", label: "3M 起始",      minGames: 30, minWinRate: 0.55 },
  { key: "cash:10000000",label: "10M 起始",     minGames: 50, minWinRate: 0.60 },
];

function isUnlocked(key, hist) {
  // 預設已解鎖（永遠可用）的項目
  const FREE = new Set(["cash:100000", "diff:stable", "market:TW"]);
  if (FREE.has(key)) return true;
  const u = UNLOCKS.find((x) => x.key === key);
  if (!u) return true;
  if (!hist || !hist.length) return false;
  const games = hist.length;
  const wins = hist.filter((h) => h.roi > 0).length;
  const winRate = wins / games;
  return games >= u.minGames && winRate >= u.minWinRate;
}

function nextUnlockHint(hist) {
  for (const u of UNLOCKS) {
    if (!isUnlocked(u.key, hist)) {
      const games = hist?.length || 0;
      const wins = (hist || []).filter((h) => h.roi > 0).length;
      const winRate = games ? wins / games : 0;
      const needGames = Math.max(0, u.minGames - games);
      const wrPct = (winRate * 100).toFixed(0);
      const reqPct = (u.minWinRate * 100).toFixed(0);
      return `下個解鎖：${u.label}（再 ${needGames} 場 + 勝率 ${wrPct}/${reqPct}%）`;
    }
  }
  return "所有選項已全部解鎖 ✦";
}

function tradeFee(gross) {
  const c = currentCosts();
  return Math.max(c.minFee, Math.floor(gross * c.fee));
}
function tradeTax(gross) {
  return Math.floor(gross * currentCosts().tax);
}

const state = {
  stocks: [],
  stock: null,
  market: localStorage.getItem(LS_MARKET) || "TW",
  initialCash: +localStorage.getItem(LS_CASH) || DEFAULT_INITIAL_CASH,
  difficulty: localStorage.getItem(LS_DIFFICULTY) || "stable",
  indicator: localStorage.getItem(LS_INDICATOR) || "kd",
  kperiod: localStorage.getItem(LS_KPERIOD) || "D",
  prices: [],
  startIdx: 0,
  cursor: 0,
  cash: 0,
  pos: 0,
  avg: 0,
  realized: 0,
  log: [],
  trades: 0,
  over: false,
};

function currentCosts() {
  return MARKET_COSTS[state.market] || MARKET_COSTS.TW;
}
// Backwards-compatible aliases used by existing code paths
Object.defineProperty(window, "FEE_RATE", { get: () => currentCosts().fee });
Object.defineProperty(window, "TAX_RATE", { get: () => currentCosts().tax });

let chart, candleSeries, volumeSeries, ma5Line, ma20Line, ma60Line, bbUpper, bbLower;
let indChart, kLine, dLine, rsiLine, rsi70, rsi30;

async function loadCatalog() {
  const r = await fetch("data/stocks.json");
  state.stocks = await r.json();
}

async function loadPrices(id) {
  const r = await fetch(`data/prices/${id}.json`);
  return await r.json();
}

// 把日 K bars 聚合成 周/月 K（OHLCV）
function bucketKey(dateStr, tf) {
  if (tf === "D") return dateStr;
  const d = new Date(dateStr);
  if (tf === "W") {
    // ISO 週：以週一為起點
    const day = d.getUTCDay() || 7;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - (day - 1));
    return monday.toISOString().slice(0, 10);
  }
  if (tf === "M") {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  return dateStr;
}

function aggregateBars(bars, tf) {
  if (tf === "D" || !bars || bars.length === 0) return bars;
  const out = [];
  let bucket = null;
  for (const p of bars) {
    const key = bucketKey(p.t, tf);
    if (!bucket || bucket.key !== key) {
      if (bucket) out.push(bucket.bar);
      bucket = {
        key,
        bar: { t: p.t, o: p.o, h: p.h, l: p.l, c: p.c, v: p.v || 0 },
      };
    } else {
      bucket.bar.h = Math.max(bucket.bar.h, p.h);
      bucket.bar.l = Math.min(bucket.bar.l, p.l);
      bucket.bar.c = p.c;
      bucket.bar.v += (p.v || 0);
      // 保留最後一天日期作為 bucket 的時間軸座標（避免重複 time）
      bucket.bar.t = p.t;
    }
  }
  if (bucket) out.push(bucket.bar);
  return out;
}

function ma(arr, n, key = "c") {
  const out = [];
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i][key];
    if (i >= n) sum -= arr[i - n][key];
    if (i >= n - 1) out.push({ time: arr[i].t, value: +(sum / n).toFixed(2) });
  }
  return out;
}

// KD 全序列（用於副圖）
function kdSeries(arr, n = 9) {
  const kArr = [], dArr = [];
  let k = 50, d = 50;
  for (let i = n - 1; i < arr.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      if (arr[j].h > hi) hi = arr[j].h;
      if (arr[j].l < lo) lo = arr[j].l;
    }
    const rsv = hi === lo ? 50 : ((arr[i].c - lo) / (hi - lo)) * 100;
    k = (k * 2 + rsv) / 3;
    d = (d * 2 + k) / 3;
    kArr.push({ time: arr[i].t, value: +k.toFixed(2) });
    dArr.push({ time: arr[i].t, value: +d.toFixed(2) });
  }
  return { k: kArr, d: dArr };
}

// RSI 全序列
function rsiSeries(arr, n = 14) {
  const out = [];
  if (arr.length <= n) return out;
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= n; i++) {
    const ch = arr[i].c - arr[i - 1].c;
    if (ch > 0) avgG += ch; else avgL -= ch;
  }
  avgG /= n; avgL /= n;
  const rsiOf = (g, l) => l === 0 ? 100 : 100 - 100 / (1 + g / l);
  out.push({ time: arr[n].t, value: +rsiOf(avgG, avgL).toFixed(2) });
  for (let i = n + 1; i < arr.length; i++) {
    const ch = arr[i].c - arr[i - 1].c;
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgG = (avgG * (n - 1) + g) / n;
    avgL = (avgL * (n - 1) + l) / n;
    out.push({ time: arr[i].t, value: +rsiOf(avgG, avgL).toFixed(2) });
  }
  return out;
}

// KD 隨機指標：9 期 RSV，K = 1/3 RSV + 2/3 prevK，D = 1/3 K + 2/3 prevD（台股慣例）
function kdValue(arr, idx, n = 9) {
  if (idx < n - 1) return null;
  let k = 50, d = 50;
  for (let i = n - 1; i <= idx; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      if (arr[j].h > hi) hi = arr[j].h;
      if (arr[j].l < lo) lo = arr[j].l;
    }
    const rsv = hi === lo ? 50 : ((arr[i].c - lo) / (hi - lo)) * 100;
    k = (k * 2 + rsv) / 3;
    d = (d * 2 + k) / 3;
  }
  return { k, d };
}

// RSI 14：相對強弱指標（Wilder 平滑法）
function rsiValue(arr, idx, n = 14) {
  if (idx < n) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= n; i++) {
    const ch = arr[i].c - arr[i - 1].c;
    if (ch > 0) avgGain += ch; else avgLoss -= ch;
  }
  avgGain /= n; avgLoss /= n;
  for (let i = n + 1; i <= idx; i++) {
    const ch = arr[i].c - arr[i - 1].c;
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (n - 1) + g) / n;
    avgLoss = (avgLoss * (n - 1) + l) / n;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function bollinger(arr, n = 20, k = 2) {
  const up = [], lo = [];
  for (let i = n - 1; i < arr.length; i++) {
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += arr[j].c;
    const m = sum / n;
    let sq = 0;
    for (let j = i - n + 1; j <= i; j++) sq += (arr[j].c - m) ** 2;
    const sd = Math.sqrt(sq / n);
    up.push({ time: arr[i].t, value: +(m + k * sd).toFixed(2) });
    lo.push({ time: arr[i].t, value: +(m - k * sd).toFixed(2) });
  }
  return { up, lo };
}

function toCandle(p) {
  return { time: p.t, open: p.o, high: p.h, low: p.l, close: p.c };
}
function toVol(p) {
  const up = p.c >= p.o;
  return {
    time: p.t,
    value: p.v,
    color: up ? "rgba(63,185,80,0.5)" : "rgba(224,82,82,0.5)",
  };
}

function setupChart() {
  const el = document.getElementById("chart");
  el.innerHTML = "";
  chart = LightweightCharts.createChart(el, {
    layout: { background: { color: "#0e1116" }, textColor: "#e6edf3" },
    grid: {
      vertLines: { color: "#1c222b" },
      horzLines: { color: "#1c222b" },
    },
    crosshair: { mode: 0 },
    rightPriceScale: { borderColor: "#2a313c" },
    timeScale: { borderColor: "#2a313c", rightOffset: 5 },
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: "#e05252",
    downColor: "#3fb950",
    borderUpColor: "#e05252",
    borderDownColor: "#3fb950",
    wickUpColor: "#e05252",
    wickDownColor: "#3fb950",
  });
  volumeSeries = chart.addHistogramSeries({
    priceFormat: { type: "volume" },
    priceScaleId: "vol",
    scaleMargins: { top: 0.8, bottom: 0 },
  });
  chart.priceScale("vol").applyOptions({
    scaleMargins: { top: 0.8, bottom: 0 },
  });
  ma5Line = chart.addLineSeries({ color: "#5a9cf8", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  ma20Line = chart.addLineSeries({ color: "#f0b75c", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  ma60Line = chart.addLineSeries({ color: "#b37cf0", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  bbUpper = chart.addLineSeries({ color: "rgba(255,255,255,0.85)", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
  bbLower = chart.addLineSeries({ color: "rgba(255,255,255,0.85)", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });

  // KD / RSI 副圖
  const indEl = document.getElementById("ind-chart");
  indEl.innerHTML = "";
  indChart = LightweightCharts.createChart(indEl, {
    layout: { background: { color: "#0e1116" }, textColor: "#7a8290" },
    grid: {
      vertLines: { color: "#1c222b" },
      horzLines: { color: "#1c222b" },
    },
    rightPriceScale: { borderColor: "#2a313c" },
    timeScale: { borderColor: "#2a313c", visible: false },
    crosshair: { mode: 0 },
    handleScroll: false,
    handleScale: false,
  });
  kLine = indChart.addLineSeries({
    color: "#00f0ff", lineWidth: 1, title: "K",
    priceLineVisible: false, lastValueVisible: true,
  });
  dLine = indChart.addLineSeries({
    color: "#ff00d4", lineWidth: 1, title: "D",
    priceLineVisible: false, lastValueVisible: true,
  });
  rsiLine = indChart.addLineSeries({
    color: "#f6ff00", lineWidth: 1, title: "RSI",
    priceLineVisible: false, lastValueVisible: true,
  });
  // 30 / 70 參考線
  rsi70 = indChart.addLineSeries({
    color: "rgba(246,255,0,0.18)", lineWidth: 1, lineStyle: 2,
    priceLineVisible: false, lastValueVisible: false,
  });
  rsi30 = indChart.addLineSeries({
    color: "rgba(246,255,0,0.18)", lineWidth: 1, lineStyle: 2,
    priceLineVisible: false, lastValueVisible: false,
  });

  // 主圖 → 副圖 單向同步（避免雙向訂閱造成迴圈）
  let _syncing = false;
  chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
    if (!r || _syncing) return;
    _syncing = true;
    indChart.timeScale().setVisibleLogicalRange(r);
    _syncing = false;
  });

  const resizeCharts = () => {
    const r1 = el.getBoundingClientRect();
    if (r1.width > 0 && r1.height > 0) chart.resize(r1.width, r1.height);
    const r2 = indEl.getBoundingClientRect();
    if (r2.width > 0 && r2.height > 0) indChart.resize(r2.width, r2.height);
  };
  window.addEventListener("resize", resizeCharts);
  if (window.ResizeObserver) {
    new ResizeObserver(resizeCharts).observe(el);
    new ResizeObserver(resizeCharts).observe(indEl);
  }
  setTimeout(resizeCharts, 50);
}

function renderIndChart(slice) {
  if (slice.length === 0) return;
  const t0 = slice[0].t, t1 = slice[slice.length - 1].t;
  if (state.indicator === "rsi") {
    kLine.setData([]);
    dLine.setData([]);
    rsiLine.setData(rsiSeries(slice));
    rsi70.setData([{ time: t0, value: 70 }, { time: t1, value: 70 }]);
    rsi30.setData([{ time: t0, value: 30 }, { time: t1, value: 30 }]);
  } else {
    // KD
    const kd = kdSeries(slice);
    kLine.setData(kd.k);
    dLine.setData(kd.d);
    rsiLine.setData([]);
    rsi70.setData([{ time: t0, value: 80 }, { time: t1, value: 80 }]);
    rsi30.setData([{ time: t0, value: 20 }, { time: t1, value: 20 }]);
  }
}

function applyIndicatorUI() {
  const sel = document.getElementById("indicatorSelect");
  if (sel) sel.value = state.indicator;
  const k = document.getElementById("kPeriodSelect");
  if (k) k.value = state.kperiod || "D";
}

function renderChart(fit = true) {
  const dailySlice = state.prices.slice(0, state.cursor + 1);
  const slice = aggregateBars(dailySlice, state.kperiod);
  candleSeries.setData(slice.map(toCandle));
  volumeSeries.setData(slice.map(toVol));
  ma5Line.setData(ma(slice, 5));
  ma20Line.setData(ma(slice, 20));
  ma60Line.setData(ma(slice, 60));
  const bb = bollinger(slice, 20, 2);
  bbUpper.setData(bb.up);
  bbLower.setData(bb.lo);
  renderIndChart(slice);
  if (fit) chart.timeScale().fitContent();
}

function appendBar() {
  if (state.kperiod === "D") {
    // 日 K 模式：增量更新最後一根 bar，不重畫整圖、不 fitContent，避免跑版閃爍
    const p = state.prices[state.cursor];
    candleSeries.update(toCandle(p));
    volumeSeries.update(toVol(p));
    const slice = state.prices.slice(0, state.cursor + 1);
    ma5Line.setData(ma(slice, 5));
    ma20Line.setData(ma(slice, 20));
    ma60Line.setData(ma(slice, 60));
    const bb = bollinger(slice, 20, 2);
    bbUpper.setData(bb.up);
    bbLower.setData(bb.lo);
    renderIndChart(slice);
  } else {
    // 周/月 K：最後 bucket 可能會擴展，整段重畫但不 fit（避免縮放跳動）
    renderChart(false);
  }
}

function nowPrice() {
  return state.prices[state.cursor].c;
}
function nowDate() {
  return state.prices[state.cursor].t;
}

function fmt(n, d = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

function updatePanel() {
  const price = nowPrice();
  document.getElementById("stockLabel").textContent = "??? ???";
  document.getElementById("dateLabel").textContent = "????-??-??";
  document.getElementById("roundsLeft").textContent =
    TOTAL_ROUNDS - state.trades > 0
      ? TOTAL_ROUNDS - (state.cursor - state.startIdx)
      : 0;
  document.getElementById("priceNow").textContent = fmt(price, 2);
  const posEl = document.getElementById("pos");
  if (state.pos > 0) {
    posEl.textContent = `多 ${fmt(state.pos)}`;
    posEl.className = "pos-pnl";
  } else if (state.pos < 0) {
    posEl.textContent = `空 ${fmt(-state.pos)}`;
    posEl.className = "neg-pnl";
  } else {
    posEl.textContent = "—";
    posEl.className = "";
  }
  document.getElementById("avg").textContent =
    state.pos !== 0 ? fmt(state.avg, 2) : "—";
  const unreal =
    state.pos > 0
      ? (price - state.avg) * state.pos
      : state.pos < 0
      ? (state.avg - price) * -state.pos
      : 0;
  const unrealEl = document.getElementById("unreal");
  unrealEl.textContent = fmt(unreal, 0);
  unrealEl.className = unreal > 0 ? "pos-pnl" : unreal < 0 ? "neg-pnl" : "";

  document.getElementById("cash").textContent = fmt(state.cash, 0);
  const equity = state.cash + state.pos * price;
  document.getElementById("equity").textContent = fmt(equity, 0);
  const realEl = document.getElementById("realized");
  realEl.textContent = fmt(state.realized, 0);
  realEl.className = state.realized > 0 ? "pos-pnl" : state.realized < 0 ? "neg-pnl" : "";
  const roi = ((equity - state.initialCash) / state.initialCash) * 100;
  const roiEl = document.getElementById("roi");
  roiEl.textContent = `${roi >= 0 ? "+" : ""}${roi.toFixed(2)}%`;
  roiEl.className = roi > 0 ? "pos-pnl" : roi < 0 ? "neg-pnl" : "";

  renderLog();
}

function renderLog() {
  const ul = document.getElementById("log");
  ul.innerHTML = "";
  for (const l of state.log.slice().reverse().slice(0, 50)) {
    const li = document.createElement("li");
    li.className = l.side;
    li.textContent = `${l.t} ${l.side === "buy" ? "買" : "賣"} ${fmt(l.qty)}@${l.p.toFixed(2)}  ${l.pnl !== undefined ? `損益 ${fmt(l.pnl, 0)}` : ""}`;
    ul.appendChild(li);
  }
}

function buy() {
  if (state.over) return;
  let qty = +document.getElementById("qty").value;
  if (qty <= 0) return;
  const price = nowPrice();
  let totalPnl = 0;
  let coveredProfit = null;

  // Phase 1: cover existing short
  if (state.pos < 0) {
    const qtyCover = Math.min(qty, -state.pos);
    const gross = price * qtyCover;
    const fee = tradeFee(gross);
    if (state.cash < gross + fee) {
      alert("現金不足");
      window.SFX && SFX.error();
      return;
    }
    const pnl = (state.avg - price) * qtyCover - fee;
    state.cash -= gross + fee;
    state.pos += qtyCover;
    state.realized += pnl;
    totalPnl += pnl;
    coveredProfit = pnl >= 0;
    qty -= qtyCover;
    if (state.pos === 0) state.avg = 0;
  }

  // Phase 2: open/add long
  if (qty > 0) {
    const gross = price * qty;
    const fee = tradeFee(gross);
    if (state.cash < gross + fee) {
      alert(state.pos > 0 ? "現金不足加碼" : "現金不足");
      window.SFX && SFX.error();
      if (coveredProfit === null) return;
    } else {
      const prevPos = Math.max(state.pos, 0);
      state.avg = (state.avg * prevPos + gross) / (prevPos + qty);
      state.pos += qty;
      state.cash -= gross + fee;
    }
  }

  state.trades++;
  state.log.push({
    t: nowDate(), side: "buy",
    qty: +document.getElementById("qty").value,
    p: price, pnl: totalPnl || undefined,
  });
  window.SFX && (coveredProfit !== null ? SFX.sell(coveredProfit) : SFX.buy());
  updatePanel();
  checkEnd();
}

function sell() {
  if (state.over) return;
  let qty = +document.getElementById("qty").value;
  if (qty <= 0) return;
  const price = nowPrice();
  let totalPnl = 0;
  let closedProfit = null;

  // Phase 1: close existing long
  if (state.pos > 0) {
    const qtyClose = Math.min(qty, state.pos);
    const gross = price * qtyClose;
    const fee = tradeFee(gross);
    const tax = tradeTax(gross);
    const pnl = (price - state.avg) * qtyClose - fee - tax;
    state.cash += gross - fee - tax;
    state.pos -= qtyClose;
    state.realized += pnl;
    totalPnl += pnl;
    closedProfit = pnl >= 0;
    qty -= qtyClose;
    if (state.pos === 0) state.avg = 0;
  }

  // Phase 2: open/add short (gets proceeds, acts as collateral)
  if (qty > 0) {
    const gross = price * qty;
    const fee = tradeFee(gross);
    const tax = tradeTax(gross);
    // soft margin check: total short exposure <= current equity × 2
    const newShortAbs = -state.pos + qty;
    const equity = state.cash + state.pos * price;
    if (newShortAbs * price > equity * 2) {
      alert("保證金不足 (空單最多 2 倍槓桿)");
      window.SFX && SFX.error();
      if (closedProfit === null) return;
    } else {
      const prevShort = Math.max(-state.pos, 0);
      state.avg = (state.avg * prevShort + gross) / (prevShort + qty);
      state.pos -= qty;
      state.cash += gross - fee - tax;
    }
  }

  state.trades++;
  state.log.push({
    t: nowDate(), side: "sell",
    qty: +document.getElementById("qty").value,
    p: price, pnl: totalPnl || undefined,
  });
  window.SFX && (closedProfit !== null ? SFX.sell(closedProfit) : SFX.buy());
  updatePanel();
  checkEnd();
}

function nextDay() {
  if (state.over) return;
  if (state.cursor >= state.prices.length - 1) {
    finish();
    return;
  }
  state.cursor++;
  appendBar();
  updatePanel();
  window.SFX && SFX.tick();
  if (state.cursor - state.startIdx >= TOTAL_ROUNDS) {
    finish();
  }
}

function checkEnd() {
  if (state.cursor - state.startIdx >= TOTAL_ROUNDS) finish();
}

function finish() {
  if (state.over) return;
  state.over = true;
  const price = nowPrice();

  // 結算時若仍有持倉 → 自動補一筆「結算平倉」交易紀錄
  // 讓單筆勝率 / 平均盈虧 / 最終資產 都正確反映扣費後的結果
  if (state.pos !== 0) {
    const qty = Math.abs(state.pos);
    const gross = price * qty;
    const fee = tradeFee(gross);
    const tax = state.pos > 0 ? tradeTax(gross) : 0;  // 賣出才有證交稅
    const pnl = state.pos > 0
      ? (price - state.avg) * qty - fee - tax     // 多單平倉
      : (state.avg - price) * qty - fee;          // 空單回補
    state.log.push({
      t: nowDate(),
      side: state.pos > 0 ? "sell" : "buy",
      qty,
      p: price,
      pnl,
      auto: true,
    });
    state.realized += pnl;
    if (state.pos > 0) {
      state.cash += gross - fee - tax;            // 賣出收回 cash
    } else {
      state.cash -= gross + fee;                  // 回補付出 cash
    }
    state.pos = 0;
    state.avg = 0;
  }

  const equity = state.cash + state.pos * price;
  const roi = ((equity - state.initialCash) / state.initialCash) * 100;
  const startPrice = state.prices[state.startIdx].c;
  const bench = ((price - startPrice) / startPrice) * 100;
  const alpha = roi - bench;

  saveResult({
    date: new Date().toISOString(),
    stockId: state.stock.id,
    stockName: state.stock.name,
    stock: `${state.stock.id} ${state.stock.name}`,  // legacy 相容
    market: state.market,
    difficulty: state.difficulty,
    initialCash: state.initialCash,
    from: state.prices[state.startIdx].t,
    to: nowDate(),
    equity: Math.round(equity),
    roi: +roi.toFixed(2),
    bench: +bench.toFixed(2),
    alpha: +(roi - bench).toFixed(2),
    trades: state.trades,
    log: (state.log || []).slice(),  // 完整逐筆紀錄
  });

  showResult({ equity, roi, bench, alpha });
}

// 保留最近一場結算資料（給複製/列印用）
let lastResult = null;

function showResult({ equity, roi, bench, alpha }) {
  lastResult = {
    nick: getNick(),
    stock: state.stock,
    market: state.market,
    difficulty: state.difficulty,
    initialCash: state.initialCash,
    fromDate: state.prices[state.startIdx].t,
    toDate: nowDate(),
    equity, roi, bench, alpha,
    trades: state.trades,
    rounds: state.cursor - state.startIdx,
  };
  const set = (id, text, cls) => {
    const el = document.getElementById(id);
    el.textContent = text;
    if (cls !== undefined) {
      el.classList.remove("good", "bad");
      if (cls) el.classList.add(cls);
    }
  };

  const sign = (n) => (n >= 0 ? "+" : "");
  const cls = (n) => (n > 0 ? "good" : n < 0 ? "bad" : null);

  document.getElementById("revealStock").textContent =
    `${state.stock.id} · ${state.stock.name}`;
  document.getElementById("revealRange").textContent =
    `${state.prices[state.startIdx].t}  →  ${nowDate()}`;

  set("rsEquity", fmt(equity, 0));
  set("rsRoi", `${sign(roi)}${roi.toFixed(2)}%`, cls(roi));
  set("rsBench", `${sign(bench)}${bench.toFixed(2)}%`, cls(bench));
  set("rsAlpha", `${sign(alpha)}${alpha.toFixed(2)}%`, cls(alpha));
  set("rsTrades", state.trades);

  // 單筆交易盈虧統計（只計入有 pnl 的「平倉」紀錄）
  const closes = (state.log || []).filter(
    (l) => typeof l.pnl === "number" && !Number.isNaN(l.pnl)
  );
  if (closes.length) {
    const pnls = closes.map((l) => l.pnl);
    const wins = pnls.filter((p) => p > 0).length;
    const winRate = (wins / closes.length) * 100;
    const avg = pnls.reduce((a, b) => a + b, 0) / closes.length;
    const best = Math.max(...pnls);
    const worst = Math.min(...pnls);
    const baseline = state.initialCash || 1;
    const pct = (n) => `${(n / baseline) * 100 >= 0 ? "+" : ""}${
      ((n / baseline) * 100).toFixed(2)
    }%`;
    set("rsTradeWin", `${wins}/${closes.length} = ${winRate.toFixed(0)}%`,
        winRate >= 50 ? "good" : "bad");
    set("rsTradePnL", `${pct(avg)} / ${pct(best)} / ${pct(worst)}`);
  } else {
    set("rsTradeWin", "—");
    set("rsTradePnL", "—");
  }

  // 交易明細列表
  const tradeList = document.getElementById("tradeList");
  if (tradeList) {
    tradeList.innerHTML = "";
    (state.log || []).forEach((l, i) => {
      const li = document.createElement("li");
      const sideTxt = l.auto
        ? (l.side === "buy" ? "結算回補" : "結算平倉")
        : (l.side === "buy" ? "買" : "賣");
      const sideCls = l.side === "buy" ? "tr-side-buy" : "tr-side-sell";
      const left = document.createElement("span");
      left.textContent = `#${i + 1} ${l.t}`;
      const mid = document.createElement("span");
      mid.innerHTML =
        `<span class="${sideCls}">${sideTxt}</span> ${fmt(l.qty, 0)} @ ${
          (+l.p).toFixed(2)
        }`;
      const right = document.createElement("span");
      if (typeof l.pnl === "number") {
        right.textContent =
          `${l.pnl >= 0 ? "+" : ""}${Math.round(l.pnl).toLocaleString()}`;
        right.className = l.pnl >= 0 ? "tr-pnl-pos" : "tr-pnl-neg";
      } else {
        right.textContent = "—";
      }
      li.append(left, mid, right);
      tradeList.appendChild(li);
    });
  }

  // 4-象限判定：賺賠（roi）與超額報酬（alpha）獨立評價
  const v = document.getElementById("resultVerdict");
  v.classList.remove("win", "lose", "mixed");
  const profit = roi > 0;
  const beatMkt = alpha > 0;
  if (profit && beatMkt) {
    v.textContent = "✦ 完美擊敗市場 ✦";
    v.classList.add("win");
  } else if (profit && !beatMkt && alpha < 0) {
    v.textContent = "✓ 賺錢但跑輸大盤";
    v.classList.add("mixed");
  } else if (!profit && beatMkt) {
    v.textContent = "△ 虧損但贏過大盤";
    v.classList.add("mixed");
  } else if (!profit && alpha < 0) {
    v.textContent = "× 雙雙落敗 ×";
    v.classList.add("lose");
  } else {
    v.textContent = "━ 與市場打平 ━";
  }

  document.getElementById("game-screen").classList.add("hidden");
  document.getElementById("result-screen").classList.remove("hidden");
  // 賺錢就放贏的音效；只有真的虧錢才放輸
  window.SFX && (roi > 0 || alpha > 0 ? SFX.win() : SFX.lose());
  // 局結束可能達成解鎖條件
  applyUnlocks();
  refreshPoolHint();
}

// ========== 戰績輸出 ==========
function buildResultText() {
  if (!lastResult) return "";
  const r = lastResult;
  const sign = (n) => (n >= 0 ? "+" : "");
  const diffLabel = (DIFFICULTY[r.difficulty] || {}).label || r.difficulty;
  const verdict = document.getElementById("resultVerdict")?.textContent || "";
  return [
    "═══════════════════════════════",
    " 趨勢回放 · TREND REPLAY 戰績",
    "═══════════════════════════════",
    ` 玩家   ${r.nick}`,
    ` 個股   ${r.stock.id} · ${r.stock.name}`,
    ` 市場   ${r.market === "TW" ? "台股" : "美股"} / 難度 ${diffLabel}`,
    ` 期間   ${r.fromDate}  →  ${r.toDate}  (${r.rounds} 天)`,
    "───────────────────────────────",
    ` 起始資金   ${fmt(r.initialCash, 0)}`,
    ` 最終總資產 ${fmt(Math.round(r.equity), 0)}`,
    ` 報酬率     ${sign(r.roi)}${r.roi.toFixed(2)}%`,
    ` 大盤基準   ${sign(r.bench)}${r.bench.toFixed(2)}%`,
    ` 超額報酬   ${sign(r.alpha)}${r.alpha.toFixed(2)}%`,
    ` 交易次數   ${r.trades}`,
    "───────────────────────────────",
    ` ${verdict}`,
    "═══════════════════════════════",
  ].join("\n");
}

// 建立 PDF 用的條列式交易紀錄報表（黑字白底，乾淨無樣式）
function buildReportElement() {
  const r = lastResult;
  if (!r) return null;
  const log = state.log || [];

  // 計算累計買進/賣出金額（含 auto-close）
  let totalBuy = 0, totalSell = 0;
  for (const l of log) {
    const amt = (+l.qty) * (+l.p);
    if (l.side === "buy") totalBuy += amt;
    else totalSell += amt;
  }
  const sign = (n) => (n >= 0 ? "+" : "");
  const fmtN = (n) => Math.round(n).toLocaleString();

  const items = log.map((l, i) => {
    const sideTxt = l.auto
      ? (l.side === "buy" ? "結算回補" : "結算平倉")
      : (l.side === "buy" ? "買進" : "賣出");
    const qtyTxt = (+l.qty).toLocaleString();
    const priceTxt = (+l.p).toFixed(2);
    const amtTxt = fmtN((+l.qty) * (+l.p));
    const pnlTxt = typeof l.pnl === "number"
      ? `　損益 <b style="color:${l.pnl >= 0 ? "#0a6e3a" : "#b00020"}">${
          l.pnl >= 0 ? "+" : ""}${fmtN(l.pnl)}</b>`
      : "";
    return `<li style="padding:4px 0;border-bottom:1px dashed #ccc">
      <span style="color:#666">[${l.t}]</span>
      <b>${sideTxt}</b> ${qtyTxt} 股 @ ${priceTxt}
      <span style="color:#888">($${amtTxt})</span>${pnlTxt}
    </li>`;
  }).join("");

  const div = document.createElement("div");
  div.style.cssText = [
    "position:fixed", "left:-9999px", "top:0",
    "width:720px", "padding:32px",
    "background:white", "color:#222",
    "font-family:'Microsoft JhengHei','Segoe UI','Noto Sans TC',sans-serif",
    "font-size:13px", "line-height:1.7",
  ].join(";");

  div.innerHTML = `
    <div style="margin-bottom:10px">
      <div style="font-size:18px;font-weight:700">${r.stock.id} · ${r.stock.name}　交易紀錄</div>
      <div style="font-size:12px;color:#666;margin-top:2px">
        ${r.fromDate} → ${r.toDate}　·　玩家 ${r.nick || "-"}　·　${r.market === "TW" ? "台股" : "美股"}
      </div>
    </div>

    <table style="width:100%;border-collapse:collapse;margin-bottom:14px;font-size:12px;background:#fafafa;border:1px solid #ddd">
      <tr>
        <td style="padding:6px 10px;border-right:1px solid #eee">起始資金<br><b style="font-size:14px">${fmtN(r.initialCash)}</b></td>
        <td style="padding:6px 10px;border-right:1px solid #eee">累計買進<br><b style="font-size:14px;color:#b00020">${fmtN(totalBuy)}</b></td>
        <td style="padding:6px 10px;border-right:1px solid #eee">累計賣出<br><b style="font-size:14px;color:#0a6e3a">${fmtN(totalSell)}</b></td>
        <td style="padding:6px 10px">最終結算<br><b style="font-size:14px;color:${r.roi >= 0 ? "#0a6e3a" : "#b00020"}">${fmtN(r.equity)} (${sign(r.roi)}${r.roi.toFixed(2)}%)</b></td>
      </tr>
    </table>

    <div style="font-size:13px;font-weight:600;margin-bottom:6px;border-left:3px solid #222;padding-left:8px">逐筆交易</div>
    <ol style="margin:0;padding-left:24px;list-style:decimal">${items || '<li style="color:#999">本局無交易</li>'}</ol>
  `;
  return div;
}

// 建立「全部戰績」報表 DOM — 按個股分組、條列式
function buildAllHistoryReportElement() {
  const nick = getNick();
  if (!nick) return null;
  const hist = getHistory(nick);
  if (!hist.length) return null;

  // group by stockId（fallback 用 stock 字串）
  const groups = new Map();
  for (const h of hist) {
    const key = h.stockId || h.stock || "未知";
    if (!groups.has(key)) groups.set(key, { name: h.stockName || "", games: [] });
    groups.get(key).games.push(h);
  }

  const sign = (n) => (n >= 0 ? "+" : "");
  const groupBlocks = [];
  for (const [stockId, info] of groups) {
    const games = info.games;
    const wins = games.filter((g) => g.roi > 0).length;
    const winRate = (wins / games.length) * 100;
    const avgRoi = games.reduce((a, b) => a + b.roi, 0) / games.length;
    const bestRoi = Math.max(...games.map((g) => g.roi));

    const items = games
      .slice()
      .sort((a, b) => (a.date || a.from).localeCompare(b.date || b.from))
      .map((g, i) => {
        const tradesTxt = g.trades != null ? `（${g.trades} 筆）` : "";
        const log = g.log || [];
        let entryExit = "";
        if (log.length > 0) {
          const entry = log[0];
          const exit = log[log.length - 1];
          const entryLabel = entry.side === "buy" ? "進" : "空";
          const exitLabel = exit.side === "buy"
            ? (exit.auto ? "回補" : "回")
            : (exit.auto ? "平倉" : "出");
          if (entry === exit) {
            entryExit = ` ${entryLabel} ${(+entry.p).toFixed(2)}`;
          } else {
            entryExit =
              ` ${entryLabel} ${(+entry.p).toFixed(2)} → ${exitLabel} ${(+exit.p).toFixed(2)}`;
          }
        }
        return `<li style="padding:3px 0;border-bottom:1px dashed #ddd">
          <span style="color:#666">[${g.from}→${g.to}]</span>
          <span style="color:#444">${entryExit}</span>
          ROI <b style="color:${g.roi >= 0 ? "#0a6e3a" : "#b00020"}">${
            sign(g.roi)}${g.roi.toFixed(2)}%</b>
          / 大盤 ${sign(g.bench || 0)}${(g.bench || 0).toFixed(2)}%
          ${tradesTxt}
        </li>`;
      })
      .join("");

    groupBlocks.push(`
      <div style="margin-bottom:18px;page-break-inside:avoid">
        <div style="font-size:15px;font-weight:700;border-left:4px solid #222;padding:2px 8px;margin-bottom:6px">
          ${stockId} ${info.name ? "· " + info.name : ""}
        </div>
        <div style="font-size:11px;color:#666;margin-bottom:6px;padding-left:8px">
          ${games.length} 局　·　勝率 ${wins}/${games.length} = ${winRate.toFixed(0)}%　·
          平均 ${sign(avgRoi)}${avgRoi.toFixed(2)}%　·　最佳 ${sign(bestRoi)}${bestRoi.toFixed(2)}%
        </div>
        <ol style="margin:0;padding-left:24px;list-style:decimal">${items}</ol>
      </div>
    `);
  }

  const totalGames = hist.length;
  const totalWins = hist.filter((h) => h.roi > 0).length;

  const div = document.createElement("div");
  div.style.cssText = [
    "position:fixed", "left:-9999px", "top:0",
    "width:720px", "padding:32px",
    "background:white", "color:#222",
    "font-family:'Microsoft JhengHei','Segoe UI','Noto Sans TC',sans-serif",
    "font-size:13px", "line-height:1.7",
  ].join(";");
  div.innerHTML = `
    <div style="border-bottom:2px solid #222;padding-bottom:8px;margin-bottom:14px">
      <div style="font-size:18px;font-weight:700">${nick} · 全部戰績</div>
      <div style="font-size:11px;color:#666;margin-top:2px">
        共 ${totalGames} 局　·　勝率 ${totalWins}/${totalGames} = ${
          ((totalWins / totalGames) * 100).toFixed(0)}%　·
        ${groups.size} 檔個股　·　Generated ${new Date().toLocaleString("zh-TW")}
      </div>
    </div>
    ${groupBlocks.join("")}
  `;
  return div;
}

async function exportAllHistory() {
  const btn = document.getElementById("btnExportAll");
  if (!window.html2canvas || !window.jspdf) return;
  const reportEl = buildAllHistoryReportElement();
  if (!reportEl) {
    alert("尚無戰績可匯出");
    return;
  }
  const orig = btn?.textContent;
  if (btn) { btn.textContent = "產生中..."; btn.disabled = true; }
  document.body.appendChild(reportEl);
  try {
    const canvas = await html2canvas(reportEl, {
      backgroundColor: "white", scale: 2, useCORS: true, logging: false,
    });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "p", unit: "mm", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 10;
    const usableW = pageW - margin * 2;
    const usableH = pageH - margin * 2;
    const imgRatio = canvas.height / canvas.width;
    const imgH = usableW * imgRatio;
    if (imgH <= usableH) {
      pdf.addImage(canvas.toDataURL("image/png"), "PNG", margin, margin, usableW, imgH);
    } else {
      const pageCanvasH = canvas.width * (usableH / usableW);
      let y = 0, pageNum = 0;
      while (y < canvas.height) {
        const sliceH = Math.min(pageCanvasH, canvas.height - y);
        const slice = document.createElement("canvas");
        slice.width = canvas.width;
        slice.height = sliceH;
        slice.getContext("2d").drawImage(
          canvas, 0, y, canvas.width, sliceH, 0, 0, canvas.width, sliceH
        );
        if (pageNum > 0) pdf.addPage();
        pdf.addImage(slice.toDataURL("image/png"), "PNG", margin, margin,
          usableW, sliceH * usableW / canvas.width);
        y += sliceH;
        pageNum++;
      }
    }
    pdf.save(`trend-replay_history_${getNick()}_${Date.now()}.pdf`);
    if (btn) btn.textContent = "✓ 已下載";
  } catch (e) {
    console.error("PDF 產生失敗", e);
    alert("PDF 產生失敗");
  } finally {
    reportEl.remove();
    if (btn) {
      btn.disabled = false;
      setTimeout(() => { if (orig) btn.textContent = orig; }, 1500);
    }
  }
}

async function printResult() {
  const btn = document.getElementById("btnPrintResult");
  if (!window.html2canvas || !window.jspdf) {
    return window.print();
  }
  const orig = btn?.textContent;
  if (btn) { btn.textContent = "產生中..."; btn.disabled = true; }
  const reportEl = buildReportElement();
  if (!reportEl) {
    if (btn) { btn.textContent = orig; btn.disabled = false; }
    return;
  }
  document.body.appendChild(reportEl);
  try {
    const canvas = await html2canvas(reportEl, {
      backgroundColor: "white",
      scale: 2,
      useCORS: true,
      logging: false,
    });
    const imgData = canvas.toDataURL("image/png");
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "p", unit: "mm", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 10;
    const usableW = pageW - margin * 2;
    const usableH = pageH - margin * 2;
    const ratio = canvas.height / canvas.width;
    let imgH = usableW * ratio;

    if (imgH <= usableH) {
      pdf.addImage(imgData, "PNG", margin, margin, usableW, imgH);
    } else {
      // 太長 → 分頁
      const pageImgH = usableH;
      const pageCanvasH = canvas.width * (pageImgH / usableW);
      let y = 0;
      let pageNum = 0;
      while (y < canvas.height) {
        const sliceH = Math.min(pageCanvasH, canvas.height - y);
        const slice = document.createElement("canvas");
        slice.width = canvas.width;
        slice.height = sliceH;
        slice.getContext("2d").drawImage(
          canvas, 0, y, canvas.width, sliceH, 0, 0, canvas.width, sliceH
        );
        const sliceData = slice.toDataURL("image/png");
        if (pageNum > 0) pdf.addPage();
        pdf.addImage(sliceData, "PNG", margin, margin, usableW, sliceH * usableW / canvas.width);
        y += sliceH;
        pageNum++;
      }
    }
    const r = lastResult;
    const fname = r
      ? `trend-replay_${r.stock?.id || "x"}_${r.toDate || Date.now()}.pdf`
      : `trend-replay_${Date.now()}.pdf`;
    pdf.save(fname);
    if (btn) btn.textContent = "✓ 已下載";
  } catch (e) {
    console.error("PDF 產生失敗", e);
    alert("PDF 產生失敗，改用瀏覽器列印");
    window.print();
  } finally {
    reportEl.remove();
    if (btn) {
      btn.disabled = false;
      setTimeout(() => { if (orig) btn.textContent = orig; }, 1500);
    }
  }
}

function endGameEarly() {
  if (state.over) return;
  // 防呆：未平倉提醒
  if (state.pos !== 0) {
    const dir = state.pos > 0 ? "多單" : "空單";
    const qty = Math.abs(state.pos);
    const price = nowPrice();
    const unreal = state.pos > 0
      ? (price - state.avg) * qty
      : (state.avg - price) * qty;
    const sign = unreal >= 0 ? "+" : "";
    const msg =
      `你還有 ${dir} ${qty.toLocaleString()} 股未平倉\n` +
      `平均成本 ${state.avg.toFixed(2)} / 現價 ${price.toFixed(2)}\n` +
      `未實現損益：${sign}${Math.round(unreal).toLocaleString()}\n\n` +
      `按「確定」→ 以現價自動平倉並結算\n` +
      `按「取消」→ 回去手動平倉`;
    if (!confirm(msg)) return;
  } else {
    if (!confirm("確定要提早結束本局?")) return;
  }
  finish();
}

// ================= Player / localStorage =================
const LS_NICK = "trendgame_nick";
const LS_HIST = "trendgame_history";

function getNick() { return localStorage.getItem(LS_NICK) || ""; }
function setNick(n) { localStorage.setItem(LS_NICK, n); }
function clearNick() { localStorage.removeItem(LS_NICK); }

function getHistory(nick) {
  const all = JSON.parse(localStorage.getItem(LS_HIST) || "{}");
  return all[nick] || [];
}
function saveResult(r) {
  const nick = getNick();
  if (!nick) return;
  const all = JSON.parse(localStorage.getItem(LS_HIST) || "{}");
  if (!all[nick]) all[nick] = [];
  all[nick].push(r);
  if (all[nick].length > 200) all[nick] = all[nick].slice(-200);
  localStorage.setItem(LS_HIST, JSON.stringify(all));
}

function calcStats(hist) {
  if (!hist.length) return { games: 0, best: null, avg: null, win: null };
  const rois = hist.map((h) => h.roi);
  const best = Math.max(...rois);
  const avg = rois.reduce((a, b) => a + b, 0) / rois.length;
  // 勝率 = 賺錢的局數（roi > 0），不再以「擊敗大盤」為唯一判準
  const wins = hist.filter((h) => h.roi > 0).length;
  return {
    games: hist.length,
    best,
    avg,
    win: (wins / hist.length) * 100,
  };
}

function renderLogin() {
  applyUnlocks();
  applyCashUI();
  applyDifficultyUI();
  applyMarketUI();
  const nick = getNick();
  const retBox = document.getElementById("returning-box");
  const newBox = document.getElementById("newuser-box");
  if (nick) {
    retBox.classList.remove("hidden");
    newBox.classList.add("hidden");
    document.getElementById("welcomeName").textContent = nick;
    const s = calcStats(getHistory(nick));
    document.getElementById("statGames").textContent = s.games;
    document.getElementById("statBest").textContent =
      s.best === null ? "—" : `${s.best >= 0 ? "+" : ""}${s.best.toFixed(1)}%`;
    document.getElementById("statAvg").textContent =
      s.avg === null ? "—" : `${s.avg >= 0 ? "+" : ""}${s.avg.toFixed(1)}%`;
    document.getElementById("statWin").textContent =
      s.win === null ? "—" : `${s.win.toFixed(0)}%`;
  } else {
    retBox.classList.add("hidden");
    newBox.classList.remove("hidden");
    document.getElementById("nickInput").value = "";
    setTimeout(() => document.getElementById("nickInput").focus(), 50);
  }
}

async function enterGame() {
  window.SFX && SFX.login();
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("result-screen").classList.add("hidden");
  document.getElementById("game-screen").classList.remove("hidden");
  document.getElementById("whoLabel").textContent = getNick();
  syncMuteBtn();
  if (!chart) {
    setupChart();
    if (!state.stocks.length) await loadCatalog();
  }
  await newGame();
  // 行動裝置 layout 完成後再強制 resize 一次，避免初始 0 高度
  setTimeout(() => {
    if (chart) {
      const el = document.getElementById("chart");
      const ind = document.getElementById("ind-chart");
      if (el?.clientWidth && el?.clientHeight) chart.resize(el.clientWidth, el.clientHeight);
      if (indChart && ind?.clientWidth && ind?.clientHeight) indChart.resize(ind.clientWidth, ind.clientHeight);
      chart.timeScale().fitContent();
    }
  }, 200);
}

function syncMuteBtn() {
  const btn = document.getElementById("btnMute");
  if (!btn) return;
  const m = window.soundMute && window.soundMute.isMuted();
  btn.textContent = m ? "🔇" : "🔊";
  btn.title = m ? "取消靜音" : "靜音";
}

function logout() {
  clearNick();
  document.getElementById("game-screen").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
  renderLogin();
}

async function newGame() {
  state.over = false;
  state.cash = state.initialCash;
  state.pos = 0;
  state.avg = 0;
  state.realized = 0;
  state.log = [];
  state.trades = 0;

  const pool = filteredPool();
  if (!pool.length) {
    alert(
      `目前無符合條件的 ${state.market === "TW" ? "台股" : "美股"}：` +
      `初始 ${fmt(state.initialCash, 0)} / ${
        (DIFFICULTY[state.difficulty] || {}).label || state.difficulty
      }。請放寬設定。`
    );
    return;
  }
  const stock = pool[Math.floor(Math.random() * pool.length)];
  state.stock = stock;
  state.prices = await loadPrices(stock.id);

  const minStart = PRE_BARS;
  const maxStart = state.prices.length - TOTAL_ROUNDS - 1;
  if (maxStart <= minStart) {
    // fallback for short histories (253-day stocks)
    state.startIdx = Math.min(PRE_BARS, state.prices.length - TOTAL_ROUNDS - 1);
  } else {
    state.startIdx =
      minStart + Math.floor(Math.random() * (maxStart - minStart));
  }
  state.cursor = state.startIdx;

  renderChart();
  updatePanel();
}

document.getElementById("btnBuy").addEventListener("click", buy);
document.getElementById("btnSell").addEventListener("click", sell);
document.getElementById("btnNext").addEventListener("click", nextDay);
document.getElementById("btnNew").addEventListener("click", () => newGame());

function applyMarketUI() {
  // 同步 game-header 的按鈕（如果還在）
  document.querySelectorAll(".market-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.market === state.market);
  });
  // 同步登入頁的下拉選單
  const sel = document.getElementById("marketSelect");
  if (sel) sel.value = state.market;
  const qty = document.getElementById("qty");
  const lot = currentCosts().lot;
  qty.min = lot;
  qty.step = lot;
  if (+qty.value < lot) qty.value = lot;
  refreshPoolHint();
}

// 依據市場 + 難度 + 起始資金過濾
function filteredPool() {
  const diff = DIFFICULTY[state.difficulty] || DIFFICULTY.stable;
  const lot = currentCosts().lot;
  return state.stocks.filter((s) => {
    if ((s.market || "TW") !== state.market) return false;
    // 至少有最低歷史價可買 1 股
    if (s.minP && s.minP * lot > state.initialCash) return false;
    // 難度（波動度）— 若 catalog 沒有 vol 欄位則不過濾
    if (typeof s.vol === "number") {
      if (s.vol < diff.volMin || s.vol > diff.volMax) return false;
    }
    return true;
  });
}

function refreshPoolHint() {
  const el = document.getElementById("poolHint");
  if (!el) return;
  const n = filteredPool().length;
  const total = state.stocks.filter(
    (s) => (s.market || "TW") === state.market
  ).length;
  el.textContent = `可玩股票池：${n} / ${total} 檔`;
  const hint = document.getElementById("unlockHint");
  if (hint) {
    const hist = getHistory(getNick());
    hint.textContent = nextUnlockHint(hist);
  }
}

function applyUnlocks() {
  const hist = getHistory(getNick());
  // 下拉 cash + market
  document.querySelectorAll(
    "#cashSelect option[data-lock], #marketSelect option[data-lock]"
  ).forEach((o) => {
    const ok = isUnlocked(o.dataset.lock, hist);
    o.disabled = !ok;
    if (!ok) {
      if (!o.textContent.includes("🔒")) o.textContent += " 🔒";
    } else {
      o.textContent = o.textContent.replace(" 🔒", "").replace("🔒", "");
    }
  });
  // 難度按鈕
  document.querySelectorAll(".diff-btn[data-lock]").forEach((b) => {
    const ok = isUnlocked(b.dataset.lock, hist);
    b.classList.toggle("locked", !ok);
    b.disabled = !ok;
    if (ok) b.textContent = b.textContent.replace(" 🔒", "").replace("🔒", "");
    else if (!b.textContent.includes("🔒")) b.textContent += " 🔒";
  });
  // 市場按鈕（僅 setup-market 有 data-lock，header 的不限）
  document.querySelectorAll(".market-btn[data-lock]").forEach((b) => {
    const ok = isUnlocked(b.dataset.lock, hist);
    b.classList.toggle("locked", !ok);
    b.disabled = !ok;
    if (ok) b.textContent = b.textContent.replace(" 🔒", "").replace("🔒", "");
    else if (!b.textContent.includes("🔒")) b.textContent += " 🔒";
  });

  // 若目前選擇被鎖（例如歷史 reset 後），降級為已解鎖選項
  if (!isUnlocked(`market:${state.market}`, hist)) {
    state.market = "TW";
    localStorage.setItem(LS_MARKET, "TW");
  }
  if (!isUnlocked(`diff:${state.difficulty}`, hist)) {
    state.difficulty = "stable";
    localStorage.setItem(LS_DIFFICULTY, "stable");
  }
  if (!isUnlocked(`cash:${state.initialCash}`, hist)) {
    state.initialCash = DEFAULT_INITIAL_CASH;
    localStorage.setItem(LS_CASH, String(DEFAULT_INITIAL_CASH));
  }
}

function applyDifficultyUI() {
  document.querySelectorAll(".diff-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.diff === state.difficulty);
  });
}

function applyCashUI() {
  const sel = document.getElementById("cashSelect");
  if (sel) sel.value = String(state.initialCash);
}

document.querySelectorAll(".market-btn").forEach((b) => {
  b.addEventListener("click", () => {
    if (b.disabled || b.classList.contains("locked")) {
      window.SFX && SFX.error();
      return;
    }
    if (state.market === b.dataset.market) return;
    state.market = b.dataset.market;
    localStorage.setItem(LS_MARKET, state.market);
    applyMarketUI();
    if (!document.getElementById("game-screen").classList.contains("hidden")) {
      newGame();
    }
  });
});

// ----- 設定（起始資金 / 市場 / 難度）handlers -----
document.getElementById("cashSelect")?.addEventListener("change", (e) => {
  state.initialCash = +e.target.value || DEFAULT_INITIAL_CASH;
  localStorage.setItem(LS_CASH, String(state.initialCash));
  refreshPoolHint();
});
document.getElementById("marketSelect")?.addEventListener("change", (e) => {
  const v = e.target.value;
  // 鎖定狀態下回退
  const opt = e.target.selectedOptions[0];
  if (opt?.disabled) {
    e.target.value = state.market;
    window.SFX && SFX.error();
    return;
  }
  state.market = v;
  localStorage.setItem(LS_MARKET, state.market);
  applyMarketUI();
});
document.querySelectorAll(".diff-btn").forEach((b) => {
  b.addEventListener("click", () => {
    if (b.disabled || b.classList.contains("locked")) {
      window.SFX && SFX.error();
      return;
    }
    state.difficulty = b.dataset.diff;
    localStorage.setItem(LS_DIFFICULTY, state.difficulty);
    applyDifficultyUI();
    refreshPoolHint();
  });
});

// ----- 副圖指標切換 -----
document.getElementById("indicatorSelect")?.addEventListener("change", (e) => {
  state.indicator = e.target.value;
  localStorage.setItem(LS_INDICATOR, state.indicator);
  if (state.prices?.length && state.cursor != null) {
    const dailySlice = state.prices.slice(0, state.cursor + 1);
    renderIndChart(aggregateBars(dailySlice, state.kperiod));
  }
});

// ----- K 線週期切換 -----
document.getElementById("kPeriodSelect")?.addEventListener("change", (e) => {
  state.kperiod = e.target.value;
  localStorage.setItem(LS_KPERIOD, state.kperiod);
  if (state.prices?.length && state.cursor != null) renderChart();
});

// ----- 存 PDF（直接產生，無對話框）-----
document.getElementById("btnPrintResult")?.addEventListener("click", printResult);
document.getElementById("btnExportAll")?.addEventListener("click", exportAllHistory);
document.getElementById("btnExportAllResult")?.addEventListener("click", exportAllHistory);

// ----- 攔截 Ctrl+P / 瀏覽器原生列印，注入乾淨交易明細報表 -----
let _printOverlay = null;
window.addEventListener("beforeprint", () => {
  if (_printOverlay) return;
  // 結算頁顯示中 → 用單局報表；登入頁 → 用全戰績報表
  const onResult = !document.getElementById("result-screen").classList.contains("hidden");
  const onLogin = !document.getElementById("login-screen").classList.contains("hidden");
  let el = null;
  if (onResult && lastResult) {
    el = buildReportElement();
  } else if (onLogin) {
    el = buildAllHistoryReportElement();
  }
  if (!el) return;
  // 移到可見位置，覆蓋原內容
  el.style.position = "fixed";
  el.style.left = "0";
  el.style.top = "0";
  el.style.width = "100%";
  el.style.background = "white";
  el.style.zIndex = "99999";
  el.id = "_print_overlay";
  document.body.appendChild(el);
  _printOverlay = el;
  // 隱藏其他內容
  document.body.classList.add("printing");
});
window.addEventListener("afterprint", () => {
  if (_printOverlay) {
    _printOverlay.remove();
    _printOverlay = null;
  }
  document.body.classList.remove("printing");
});
document.getElementById("btnEnd").addEventListener("click", endGameEarly);
document.getElementById("btnMute").addEventListener("click", () => {
  const m = !window.soundMute.isMuted();
  window.soundMute.setMuted(m);
  syncMuteBtn();
  if (!m) window.SFX && SFX.tick();
});
document.getElementById("btnBack").addEventListener("click", () => {
  if (state.pos > 0 && !state.over) {
    if (!confirm("你還有持股，確定要登出?")) return;
  }
  logout();
});
document.getElementById("btnAgain").addEventListener("click", () => {
  document.getElementById("result-screen").classList.add("hidden");
  document.getElementById("game-screen").classList.remove("hidden");
  newGame();
});
document.getElementById("btnBackLogin").addEventListener("click", () => {
  document.getElementById("result-screen").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
  renderLogin();
});

document.getElementById("btnLogin").addEventListener("click", () => {
  const v = document.getElementById("nickInput").value.trim();
  if (!v) {
    const inp = document.getElementById("nickInput");
    inp.style.animation = "none";
    setTimeout(() => { inp.style.animation = ""; inp.focus(); }, 10);
    return;
  }
  setNick(v);
  enterGame();
});
document.getElementById("nickInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btnLogin").click();
});
document.getElementById("btnEnter").addEventListener("click", enterGame);
document.getElementById("btnLogout").addEventListener("click", () => {
  clearNick();
  renderLogin();
});

document.getElementById("btnReset")?.addEventListener("click", () => {
  if (!confirm("確定要清除這個帳號的所有歷史戰績與統計？此操作無法復原。")) return;
  const nick = getNick();
  if (!nick) return;
  const all = JSON.parse(localStorage.getItem(LS_HIST) || "{}");
  delete all[nick];
  localStorage.setItem(LS_HIST, JSON.stringify(all));
  renderLogin();
});

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (document.getElementById("game-screen").classList.contains("hidden")) return;
  if (state.over) return;
  if (e.code === "Space") {
    e.preventDefault();
    nextDay();
  } else if (e.key === "b" || e.key === "B") {
    buy();
  } else if (e.key === "s" || e.key === "S") {
    sell();
  }
});

(async function init() {
  applyUnlocks();          // 先依歷史降級被鎖的選擇
  applyCashUI();
  applyDifficultyUI();
  applyIndicatorUI();
  applyMarketUI();
  renderLogin();
  // 提前載入 catalog 讓設定畫面能顯示池大小
  try { await loadCatalog(); } catch (e) { console.warn("catalog load failed", e); }
  refreshPoolHint();
})();
