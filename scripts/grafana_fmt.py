#!/usr/bin/env python3
"""Formatting helpers for grafana-push.sh.

Kept in a file rather than inlined as `python3 -c`: nesting quotes inside a
shell-quoted Python one-liner is how the first version broke, since backslash
escapes are not allowed inside f-string expressions.
"""
import json
import os
import sys


def search(path):
    for d in json.load(open(path, encoding="utf-8")):
        uid = d.get("uid", "")
        title = d.get("title", "")
        print("  %-18s %s" % (uid, title))


def datasources(path):
    for d in json.load(open(path, encoding="utf-8")):
        if "infinity" in d.get("type", "").lower():
            print("  %-18s %-24s %s" % (d.get("uid", ""), d.get("name", ""), d.get("type", "")))


def payload(path):
    """Export format differs from import format: __inputs must be resolved to a
    real datasource uid, and the dashboard nested under a 'dashboard' key."""
    d = json.load(open(path, encoding="utf-8"))
    uid = os.environ.get("GRAFANA_DS_UID", "")
    if uid:
        d = json.loads(json.dumps(d).replace("${DS_INFINITY}", uid))
    for k in ("__inputs", "__requires", "id"):
        d.pop(k, None)
    print(json.dumps({
        "dashboard": d,
        "overwrite": True,
        "message": "pushed by scripts/grafana-push.sh",
    }))


def result(path):
    r = json.load(open(path, encoding="utf-8"))
    if r.get("status") == "success":
        print("OK  uid=%s v%s  %s" % (r.get("uid"), r.get("version"), r.get("url", "")))
    else:
        print("FAILED  %s" % json.dumps(r)[:400])


if __name__ == "__main__":
    {"search": search, "datasources": datasources,
     "payload": payload, "result": result}[sys.argv[1]](sys.argv[2])
