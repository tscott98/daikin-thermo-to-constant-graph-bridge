#!/usr/bin/env python3
"""Render each dashboard to a PNG for the docs.

Grafana Cloud exposes its image renderer at /render/d/<uid>, authenticated with
the same token as the dashboard push, so this needs no browser and no session.

Ranges are chosen per dashboard so each screenshot shows the thing it is for
rather than whatever the default happened to be: air quality reaches back past
the bridge's own history, the rest want a couple of days of cycling.

Usage:
    python scripts/grafana_shots.py            # docs/img/*.png
    python scripts/grafana_shots.py --dark
"""
import os
import sys
import time
import urllib.error
import urllib.request

URL = os.environ["GRAFANA_URL"].rstrip("/")
TOKEN = os.environ["GRAFANA_TOKEN"]
OUT = os.path.join("docs", "img")

# Heights are per dashboard and generous: the renderer crops to the height it
# is given rather than scaling, so an undersized value silently cuts the last
# panels off the bottom of the image.
SHOTS = [
    ("daikin-air", "air-quality", "now-7d", 1400, 2100),
    ("daikin-energy", "energy", "now-2d", 1400, 1500),
    ("daikin-health", "system-health", "now-2d", 1400, 2500),
    ("daikin-dehum", "dehumidification", "now-2d", 1400, 2800),
]


def render(uid, name, frm, w, h, theme):
    q = (f"/render/d/{uid}/x?orgId=1&width={w}&height={h}&kiosk"
         f"&theme={theme}&from={frm}&to=now")
    r = urllib.request.Request(URL + q, headers={"Authorization": "Bearer " + TOKEN})
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=180) as f:
            body = f.read()
            ctype = f.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code} {e.read().decode()[:120]}"
    except Exception as e:  # noqa: BLE001 - report whatever the renderer did
        return f"ERROR {e}"
    if "image" not in ctype:
        return f"not an image ({ctype}): {body[:120]!r}"
    path = os.path.join(OUT, name + ".png")
    with open(path, "wb") as f:
        f.write(body)
    return f"ok {len(body) / 1024:6.0f} KB  {time.time() - t0:4.1f}s  {path}"


if __name__ == "__main__":
    theme = "dark" if "--dark" in sys.argv else "light"
    os.makedirs(OUT, exist_ok=True)
    for uid, name, frm, w, h in SHOTS:
        print(f"{name:20} {render(uid, name, frm, w, h, theme)}")
