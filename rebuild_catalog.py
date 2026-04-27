"""Rebuild data/stocks.json from existing data/prices/ files."""
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).parent
DATA = ROOT / "data"
PRICES = DATA / "prices"
NAMES_FILE = DATA / "tw_names.json"

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

tw_names: dict[str, dict] = {}
if NAMES_FILE.exists():
    raw = json.loads(NAMES_FILE.read_text(encoding="utf-8"))
    if raw and isinstance(next(iter(raw.values())), dict):
        tw_names = raw
    else:
        tw_names = {k: {"name": v, "suffix": ".TW"} for k, v in raw.items()}


def summarize(sid, name, market, records):
    closes = [r["c"] for r in records]
    rets = []
    for i in range(1, len(closes)):
        if closes[i - 1] > 0 and closes[i] > 0:
            rets.append(math.log(closes[i] / closes[i - 1]))
    if rets:
        m = sum(rets) / len(rets)
        var = sum((r - m) ** 2 for r in rets) / len(rets)
        vol = math.sqrt(var) * math.sqrt(252) * 100
    else:
        vol = 0.0
    return {
        "id": sid, "name": name or sid,
        "days": len(records), "market": market,
        "minP": round(min(closes), 2),
        "maxP": round(max(closes), 2),
        "lastP": round(closes[-1], 2),
        "vol": round(vol, 1),
    }


catalog = []
for f in sorted(PRICES.glob("*.json")):
    sid = f.stem  # e.g. "2330.TW", "AAPL"
    if sid.endswith(".TW") or sid.endswith(".TWO"):
        market = "TW"
        code = sid.rsplit(".", 1)[0]
        name = (tw_names.get(code) or {}).get("name") or code
    else:
        market = "US"
        name = sid  # name lookup for US can be added later
    try:
        recs = json.loads(f.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"  skip {sid}: {e}")
        continue
    if not recs or len(recs) < 30:
        continue
    catalog.append(summarize(sid, name, market, recs))

catalog.sort(key=lambda c: (c["market"], c["id"]))
(DATA / "stocks.json").write_text(
    json.dumps(catalog, ensure_ascii=False, indent=2),
    encoding="utf-8",
)
tw_n = sum(1 for c in catalog if c["market"] == "TW")
us_n = sum(1 for c in catalog if c["market"] == "US")
print(f"catalog: {len(catalog)} stocks ({tw_n} TW, {us_n} US)")
