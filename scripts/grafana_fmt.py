#!/usr/bin/env python3
"""Formatting helpers for grafana-push.sh.

Kept in a file rather than inlined as `python3 -c`: nesting quotes inside a
shell-quoted Python one-liner is how the first version broke, since backslash
escapes are not allowed inside f-string expressions.
"""
import json
import os
import re
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
    real datasource uid, and the dashboard nested under a 'dashboard' key.

    Resolving the uid is mandatory, not best-effort. Grafana's UI import flow
    prompts for a datasource and rewrites ${DS_INFINITY} on the way in; the API
    does no such thing, so an unresolved placeholder is accepted, stored, and
    then fails at render time with "Data source ds_infinity not found" on every
    panel. Pushing that is worse than not pushing, so it is an error here.
    """
    d = json.load(open(path, encoding="utf-8"))
    uid = os.environ.get("GRAFANA_DS_UID", "")
    if not uid:
        sys.exit("error: GRAFANA_DS_UID not set; grafana-push.sh resolves it")
    body = json.dumps(d).replace("${DS_INFINITY}", uid)
    left = re.findall(r"\$\{DS_[A-Z0-9_]+\}", body)
    if left:
        sys.exit(f"error: unresolved datasource placeholders in {path}: "
                 f"{sorted(set(left))}")
    d = json.loads(body)
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


def infinity_uid(path):
    """The uid of this instance's Infinity datasource, for ${DS_INFINITY}.

    Exits rather than guessing if there is not exactly one: zero means the
    datasource was never added, and several means the choice is the operator's.
    """
    found = [d for d in json.load(open(path, encoding="utf-8"))
             if "infinity" in d.get("type", "").lower()]
    if not found:
        sys.exit("error: no Infinity datasource in Grafana; add one first")
    if len(found) > 1:
        names = ", ".join("%s (%s)" % (d["name"], d["uid"]) for d in found)
        sys.exit(f"error: {len(found)} Infinity datasources ({names}); "
                 "set GRAFANA_DS_UID in .grafana-env to pick one")
    print(found[0]["uid"])


if __name__ == "__main__":
    {"search": search, "datasources": datasources, "infinity-uid": infinity_uid,
     "payload": payload, "result": result}[sys.argv[1]](sys.argv[2])
