"""Fetch index OHLCV — daily, 1h, and 5min for TAIEX / Nikkei / Nasdaq.

5-min: yfinance caps each request at ~60 days; we chunk and concat.
1h:    up to 730 days in one request.
1d:    unlimited.

Output: data/indices/{key}_{interval}.json
        [{"t":"YYYY-MM-DD HH:MM" or "YYYY-MM-DD","o":...,"h":...,"l":...,"c":...,"v":...}]
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).parent
OUT = ROOT / "data" / "indices"
OUT.mkdir(parents=True, exist_ok=True)

YEARS = 2
END = datetime.now(timezone.utc).date()
START = END - timedelta(days=365 * YEARS + 14)

# 標的清單：(顯示名, yfinance ticker, fallback ticker)
TARGETS = [
    ("taiex",   "^TWII",  None),       # 台股加權指數
    ("nikkei",  "^N225",  None),       # 日經 225
    ("nasdaq",  "^NDX",   "MNQ=F"),    # 小那（Nasdaq 100 cash → fallback Micro Nasdaq future）
]


def to_records(df: pd.DataFrame, intraday: bool) -> list[dict]:
    out = []
    for ts, row in df.iterrows():
        if any(pd.isna(row[c]) for c in ("Open", "High", "Low", "Close")):
            continue
        v = 0 if pd.isna(row.get("Volume")) else int(row.Volume)
        t = ts.strftime("%Y-%m-%d %H:%M") if intraday else ts.strftime("%Y-%m-%d")
        out.append({
            "t": t,
            "o": round(float(row.Open), 4),
            "h": round(float(row.High), 4),
            "l": round(float(row.Low), 4),
            "c": round(float(row.Close), 4),
            "v": v,
        })
    return out


def fetch_chunked(symbol: str, interval: str, days: int,
                  chunk_days: int = 55) -> pd.DataFrame:
    """Fetch intraday by sliding 60-day window."""
    end = END
    start = end - timedelta(days=days)
    parts = []
    cur = start
    while cur < end:
        c_end = min(cur + timedelta(days=chunk_days), end)
        try:
            df = yf.Ticker(symbol).history(
                start=cur.strftime("%Y-%m-%d"),
                end=(c_end + timedelta(days=1)).strftime("%Y-%m-%d"),
                interval=interval,
                auto_adjust=False,
                actions=False,
            )
            if len(df):
                parts.append(df)
            time.sleep(2)
        except Exception as e:
            print(f"  chunk {cur}->{c_end} err: {e!r}")
            time.sleep(5)
        cur = c_end + timedelta(days=1)
    if not parts:
        return pd.DataFrame()
    out = pd.concat(parts).sort_index()
    out = out[~out.index.duplicated(keep="first")]
    return out


def fetch_one(symbol: str, interval: str, period_days: int) -> pd.DataFrame:
    """Fetch range. For 5m use chunked; otherwise single request."""
    if interval == "5m":
        return fetch_chunked(symbol, "5m", period_days, chunk_days=55)
    if interval == "1h":
        return yf.Ticker(symbol).history(
            start=(END - timedelta(days=period_days)).strftime("%Y-%m-%d"),
            end=(END + timedelta(days=1)).strftime("%Y-%m-%d"),
            interval="1h",
            auto_adjust=False, actions=False,
        )
    # daily
    return yf.Ticker(symbol).history(
        start=(END - timedelta(days=period_days)).strftime("%Y-%m-%d"),
        end=(END + timedelta(days=1)).strftime("%Y-%m-%d"),
        interval="1d",
        auto_adjust=False, actions=False,
    )


def main():
    import sys
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    days = YEARS * 365
    plan = [
        ("1d", days, False),
        ("1h", days, True),
        ("5m", days, True),
    ]
    for key, primary, fallback in TARGETS:
        for interval, period_days, intraday in plan:
            print(f"\n[{key} / {interval}] fetching…")
            tickers_to_try = [primary] + ([fallback] if fallback else [])
            df = pd.DataFrame()
            used = None
            for sym in tickers_to_try:
                df = fetch_one(sym, interval, period_days)
                if len(df):
                    used = sym
                    break
                print(f"  {sym}: empty")
            if not len(df):
                print(f"  [skip] no data for {key} {interval}")
                continue
            recs = to_records(df, intraday)
            out_path = OUT / f"{key}_{interval}.json"
            out_path.write_text(json.dumps(recs, separators=(",", ":")),
                                encoding="utf-8")
            print(f"  ✓ {used} {interval}: {len(recs)} bars → "
                  f"{out_path.relative_to(ROOT)}")
            time.sleep(2)


if __name__ == "__main__":
    main()
