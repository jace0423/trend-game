"""Fetch 10-year OHLCV history for TW + US stocks via yfinance.

Output:
  data/prices/{id}.json  — minified array of {t,o,h,l,c,v}
  data/stocks.json       — catalog with {id,name,days,market}

ID format:
  TW: "{ticker}.TW"  (e.g. 2330.TW)
  US: "{ticker}"     (e.g. AAPL)

Volume:
  TW: divided by 1000 (張)
  US: as-is (shares)

Friendly fetching:
  - Browser User-Agent
  - Random sleep 1.5-3.5s between tickers
  - Exponential backoff on errors (5/10/20s)
  - Resume: skip if file already has full 10y data
  - Migrates existing TW files (1234.json -> 1234.TW.json)

Usage:
  python fetch_history.py                # full run
  python fetch_history.py --markets tw   # TW only
  python fetch_history.py --markets us   # US only
  python fetch_history.py --limit 5      # smoke test
  python fetch_history.py --force        # ignore resume cache
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from datetime import datetime, timedelta
from io import StringIO
from pathlib import Path

import pandas as pd
import requests
import yfinance as yf

ROOT = Path(__file__).parent
DATA = ROOT / "data"
PRICES = DATA / "prices"
PRICES.mkdir(parents=True, exist_ok=True)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
WIKI_HEADERS = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}

YEARS = 10
END_DATE = datetime.today().date()
START_DATE = END_DATE - timedelta(days=365 * YEARS + 30)
SLEEP_RANGE = (1.5, 3.5)
MAX_RETRIES = 3
BACKOFF_BASE = 5

# ============================================================================
# Constituent lists
# ============================================================================

# 台灣市值前段 ~150 檔（TW 50 + 中型 100 大致涵蓋）。手動維護，可自行增刪。
TW_TICKERS: list[str] = [
    # === 半導體 ===
    "2330", "2454", "2303", "2308", "2379", "2408", "2409", "2449", "3034", "3035",
    "3037", "3443", "3530", "3661", "3702", "3711", "4938", "5269", "5274", "5347",
    "6488", "6533", "6669", "6770", "6789", "8016", "8021", "8046", "8081", "8210",
    # === 電子零組件 / 通訊 ===
    "2317", "2354", "2356", "2357", "2382", "2383", "2385", "2392", "2395", "2412",
    "2474", "2492", "2498", "3017", "3023", "3044", "3045", "3231", "3380", "3406",
    "3413", "3481", "3533", "3596", "3673", "3706", "4904", "4958", "5388", "6121",
    "6176", "6271", "6285", "6409", "6415", "6464", "6526", "6552", "6781", "6890",
    # === 金融 / 保險 ===
    "2880", "2881", "2882", "2883", "2884", "2885", "2886", "2887", "2890",
    "2891", "2892", "2801", "2812", "5871", "5876", "5880",
    # === 傳產 / 化工 ===
    "1101", "1102", "1216", "1301", "1303", "1326", "1402", "1504", "1605", "1722",
    "2002", "2027", "2105", "2207", "2227", "2330", "2353", "2371", "2474",
    # === 航運 / 觀光 / 通路 ===
    "2603", "2606", "2609", "2615", "2618", "2633", "2727", "2731", "2912", "8454",
    "9904", "9910", "9914", "9921", "9933", "9939", "9941", "9945",
    # === 生技 / 其他 ===
    "1477", "1590", "1611", "1799", "2049", "2059", "2204", "2301", "2327", "2328",
    "2337", "2360", "2376", "2436", "2441", "2451", "2458", "2467", "2634", "2820",
    "3008", "3019", "3052", "3094", "3149", "3189", "3217", "3231",
    "3416", "3450", "3529", "3558", "4147", "4303", "4438", "4916",
    "4966", "6005", "6147", "6239", "6446", "6504", "6505", "6541", "6669",
    "6669", "6770", "6789", "6805", "6890", "8454", "8464", "9921", "9933",
    "9939", "9941", "9945",
    # === 保留原 50 清單中未涵蓋者 ===
    "1316", "3313", "5314", "6190", "6231", "6584", "6620", "6624", "6643",
    "6785", "6903", "6997", "7799", "8047", "8261", "8299",
]

# 去重 + 排序
TW_TICKERS = sorted(set(TW_TICKERS))


def fetch_html(url: str) -> str:
    r = requests.get(url, headers=WIKI_HEADERS, timeout=30)
    r.raise_for_status()
    return r.text


TW_NAMES_FILE = DATA / "tw_names.json"


def download_tw_names() -> dict[str, dict]:
    """Download fresh TWSE+TPEX directory. Returns {code: {name, suffix}}."""
    print("[tw] downloading TWSE+TPEX company directory...")
    out: dict[str, dict] = {}

    sources = [
        ("TWSE 上市", "https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
         ("公司代號", "公司簡稱"), ".TW"),
        ("TPEX 上櫃", "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O",
         ("SecuritiesCompanyCode", "CompanyAbbreviation"), ".TWO"),
    ]
    for label, url, (k_code, k_short), suffix in sources:
        try:
            r = requests.get(
                url, headers={"User-Agent": UA, "Accept": "application/json"},
                timeout=30,
            )
            r.raise_for_status()
            data = r.json()
            count = 0
            for row in data:
                code = str(row.get(k_code, "")).strip()
                short = str(row.get(k_short, "")).strip()
                if code and short and code not in out:
                    out[code] = {"name": short, "suffix": suffix}
                    count += 1
            print(f"  {label}: +{count} names ({len(data)} rows)")
        except Exception as e:
            print(f"  {label}: failed — {e!r}", file=sys.stderr)

    if out:
        DATA.mkdir(parents=True, exist_ok=True)
        TW_NAMES_FILE.write_text(
            json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        print(f"[tw] saved {len(out)} names → {TW_NAMES_FILE.relative_to(ROOT)}")
    return out


def get_tw_names(refresh: bool = False) -> dict[str, dict]:
    """Return {code: {name, suffix}} dict, using disk cache if present."""
    if not refresh and TW_NAMES_FILE.exists():
        try:
            d = json.loads(TW_NAMES_FILE.read_text(encoding="utf-8"))
            # Migrate old format: {code: "name"} -> {code: {name, suffix}}
            if d and isinstance(next(iter(d.values())), str):
                print("[tw] migrating cache to new format (with exchange suffix)")
                return download_tw_names()
            print(f"[tw] loaded {len(d)} entries from cache "
                  f"({TW_NAMES_FILE.relative_to(ROOT)})")
            return d
        except Exception:
            pass
    return download_tw_names()


def get_us_constituents() -> list[tuple[str, str]]:
    """S&P 500 + Nasdaq 100 from Wikipedia (deduplicated, name preferred)."""
    print("[us] fetching S&P 500 from Wikipedia...")
    sp = pd.read_html(StringIO(fetch_html(
        "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies")))[0]
    sp_pairs = [(str(s).replace(".", "-").strip(), str(n).strip())
                for s, n in zip(sp["Symbol"], sp["Security"])]

    print("[us] fetching Nasdaq 100 from Wikipedia...")
    nq_tables = pd.read_html(StringIO(fetch_html(
        "https://en.wikipedia.org/wiki/Nasdaq-100")))
    nq_pairs: list[tuple[str, str]] = []
    for t in nq_tables:
        cols = [str(c).lower() for c in t.columns]
        has_ticker = any("ticker" in c or "symbol" in c for c in cols)
        has_company = any("company" in c for c in cols)
        if has_ticker and has_company and len(t) > 50:
            tcol = t.columns[next(i for i, c in enumerate(cols)
                                  if "ticker" in c or "symbol" in c)]
            ncol = t.columns[next(i for i, c in enumerate(cols) if "company" in c)]
            nq_pairs = [(str(s).replace(".", "-").strip(), str(n).strip())
                        for s, n in zip(t[tcol], t[ncol])]
            break

    seen: dict[str, str] = {}
    for s, n in sp_pairs + nq_pairs:
        if s and s not in seen:
            seen[s] = n
    pairs = sorted(seen.items())
    print(f"[us] total unique: {len(pairs)}")
    return pairs


# ============================================================================
# Fetch + format
# ============================================================================

def polite_sleep():
    time.sleep(random.uniform(*SLEEP_RANGE))


def fetch_one(symbol: str) -> pd.DataFrame | None:
    """Fetch with retry. Returns None on failure."""
    for attempt in range(MAX_RETRIES):
        try:
            df = yf.Ticker(symbol).history(
                start=START_DATE.strftime("%Y-%m-%d"),
                end=(END_DATE + timedelta(days=1)).strftime("%Y-%m-%d"),
                auto_adjust=False,
                actions=False,
            )
            if len(df) > 0:
                return df
            print(f"  [warn] {symbol}: empty result (attempt {attempt+1}/{MAX_RETRIES})")
        except Exception as e:
            wait = BACKOFF_BASE * (2 ** attempt)
            print(f"  [err]  {symbol}: {e!r} — backoff {wait}s")
            time.sleep(wait)
            continue
        time.sleep(BACKOFF_BASE)
    return None


def summarize(sid: str, name: str, market: str,
              records: list[dict]) -> dict:
    """Build catalog entry: id/name/days/market + price summary + volatility."""
    closes = [r["c"] for r in records]
    minP = min(closes)
    maxP = max(closes)
    lastP = closes[-1]
    # 年化波動度（log return std × sqrt(252)）
    import math
    rets = []
    for i in range(1, len(closes)):
        if closes[i - 1] > 0 and closes[i] > 0:
            rets.append(math.log(closes[i] / closes[i - 1]))
    if rets:
        m = sum(rets) / len(rets)
        var = sum((r - m) ** 2 for r in rets) / len(rets)
        vol = math.sqrt(var) * math.sqrt(252) * 100  # in percent
    else:
        vol = 0.0
    return {
        "id": sid, "name": name or sid,
        "days": len(records), "market": market,
        "minP": round(minP, 2),
        "maxP": round(maxP, 2),
        "lastP": round(lastP, 2),
        "vol": round(vol, 1),
    }


def df_to_records(df: pd.DataFrame, market: str) -> list[dict]:
    """Convert yfinance DataFrame to existing JSON record format."""
    is_tw = market == "TW"
    out: list[dict] = []
    for ts, row in df.iterrows():
        if any(pd.isna(row[c]) for c in ("Open", "High", "Low", "Close")):
            continue
        v = 0 if pd.isna(row.Volume) else int(row.Volume)
        if is_tw:
            v = v // 1000
        out.append({
            "t": ts.strftime("%Y-%m-%d"),
            "o": round(float(row.Open), 4),
            "h": round(float(row.High), 4),
            "l": round(float(row.Low), 4),
            "c": round(float(row.Close), 4),
            "v": v,
        })
    return out


def existing_data_complete(path: Path, min_days: int) -> bool:
    """Resume helper: skip if file has enough data."""
    if not path.exists():
        return False
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
        return len(d) >= min_days
    except Exception:
        return False


def migrate_tw_file(old_id: str) -> Path | None:
    """Rename data/prices/{old}.json -> {old}.TW.json (one-time)."""
    old = PRICES / f"{old_id}.json"
    new = PRICES / f"{old_id}.TW.json"
    if old.exists() and not new.exists():
        old.rename(new)
        return new
    return new if new.exists() else None


# ============================================================================
# Main
# ============================================================================

def run(markets: set[str], limit: int | None, force: bool):
    catalog: list[dict] = []
    failures: list[str] = []

    targets: list[tuple[str, str, str]] = []  # (id, name, market)

    tw_dir: dict[str, dict] = {}
    if "tw" in markets:
        tw_dir = get_tw_names(refresh=getattr(run, "_refresh_names", False))
        unmatched = [raw for raw in TW_TICKERS if raw not in tw_dir]
        if unmatched:
            print(f"[tw] WARN: {len(unmatched)} tickers missing in directory:")
            print(f"    {', '.join(unmatched[:20])}"
                  f"{' ...' if len(unmatched) > 20 else ''}")
        seen = set()
        for raw in TW_TICKERS:
            entry = tw_dir.get(raw, {"name": "", "suffix": ".TW"})
            sid = f"{raw}{entry['suffix']}"
            if sid not in seen:
                targets.append((sid, entry["name"], "TW"))
                seen.add(sid)
        # --tw-all: 全部 TWSE 上市 + TPEX 上櫃
        if getattr(run, "_tw_all", False):
            extra = 0
            for raw, entry in tw_dir.items():
                sid = f"{raw}{entry['suffix']}"
                if sid not in seen:
                    targets.append((sid, entry["name"], "TW"))
                    seen.add(sid)
                    extra += 1
            print(f"[tw] --tw-all expanded: +{extra} extra tickers "
                  f"(total {len(targets)})")

    if "us" in markets:
        try:
            us_pairs = get_us_constituents()
        except Exception as e:
            print(f"[us] FAILED to fetch list: {e!r}", file=sys.stderr)
            us_pairs = []
        for sym, name in us_pairs:
            targets.append((sym, name, "US"))

    if limit:
        targets = targets[:limit]

    print(f"\n[plan] {len(targets)} tickers, {YEARS}y range "
          f"{START_DATE} → {END_DATE}\n")

    # Migrate any old TW files to new naming
    if "tw" in markets and not force:
        migrated = 0
        for raw in TW_TICKERS:
            old = PRICES / f"{raw}.json"
            new = PRICES / f"{raw}.TW.json"
            if old.exists() and not new.exists():
                old.rename(new)
                migrated += 1
        if migrated:
            print(f"[migrate] renamed {migrated} legacy TW files\n")

    expected_min_days = int(252 * YEARS * 0.85)  # 85% of trading days

    for i, (sid, default_name, market) in enumerate(targets, 1):
        out_path = PRICES / f"{sid}.json"

        if not force and existing_data_complete(out_path, expected_min_days):
            try:
                d = json.loads(out_path.read_text(encoding="utf-8"))
                catalog.append(summarize(sid, default_name, market, d))
                print(f"[{i:4d}/{len(targets)}] {sid:12s} cached ({len(d)} days)")
                continue
            except Exception:
                pass

        df = fetch_one(sid)
        if df is None or len(df) == 0:
            print(f"[{i:4d}/{len(targets)}] {sid:12s} FAILED")
            failures.append(sid)
            polite_sleep()
            continue

        records = df_to_records(df, market)
        if len(records) < 30:
            print(f"[{i:4d}/{len(targets)}] {sid:12s} too few rows ({len(records)})")
            failures.append(sid)
            polite_sleep()
            continue

        out_path.write_text(json.dumps(records, separators=(",", ":")),
                            encoding="utf-8")

        # Display name: prefer pre-loaded zh name, else fallback
        if market == "TW":
            name = default_name or sid.replace(".TW", "")
        else:
            name = default_name or sid

        catalog.append(summarize(sid, name, market, records))
        print(f"[{i:4d}/{len(targets)}] {sid:12s} {len(records):4d} days  {name}")
        polite_sleep()

    # Merge with existing catalog (keep tickers we didn't fetch this run)
    catalog_path = DATA / "stocks.json"
    if catalog_path.exists() and not force:
        try:
            existing = json.loads(catalog_path.read_text(encoding="utf-8"))
            seen_ids = {c["id"] for c in catalog}
            for s in existing:
                if s["id"] not in seen_ids:
                    # Auto-tag legacy entries
                    if "market" not in s:
                        s["market"] = "TW"
                    # Migrate legacy id format too
                    if s["market"] == "TW" and not s["id"].endswith(".TW"):
                        s["id"] = f"{s['id']}.TW"
                    catalog.append(s)
        except Exception:
            pass

    # Sort: market first, then id
    catalog.sort(key=lambda c: (c["market"], c["id"]))
    catalog_path.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"\n[done] catalog: {len(catalog)} stocks "
          f"({sum(1 for c in catalog if c['market']=='TW')} TW, "
          f"{sum(1 for c in catalog if c['market']=='US')} US)")
    if failures:
        print(f"[fail] {len(failures)} tickers failed:")
        for f in failures[:30]:
            print(f"    {f}")
        if len(failures) > 30:
            print(f"    ... and {len(failures) - 30} more")


def main():
    # 強制 stdout 用 utf-8（避免 Windows cp950 在打印中文/含重音名稱時崩潰）
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--markets", default="tw,us",
                    help="comma-separated: tw,us (default: tw,us)")
    ap.add_argument("--limit", type=int, default=None,
                    help="cap targets for testing")
    ap.add_argument("--force", action="store_true",
                    help="ignore existing files (re-fetch all)")
    ap.add_argument("--refresh-names", action="store_true",
                    help="redownload TWSE/TPEX name table")
    ap.add_argument("--names-only", action="store_true",
                    help="only download name table and exit")
    ap.add_argument("--tw-all", action="store_true",
                    help="include ALL TWSE+TPEX listed (~1965 codes)")
    args = ap.parse_args()

    if args.names_only:
        download_tw_names()
        return

    run._refresh_names = args.refresh_names
    run._tw_all = args.tw_all

    markets = {m.strip().lower() for m in args.markets.split(",") if m.strip()}
    if not markets <= {"tw", "us"}:
        print(f"unknown markets: {markets - {'tw','us'}}", file=sys.stderr)
        sys.exit(1)

    run(markets, args.limit, args.force)


if __name__ == "__main__":
    main()
