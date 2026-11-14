"""Build evidence/testnet/receipts.json (and the page copy) from the showcase logs and the scenario run.

python3 demo/receipts.py <showcase-dir> <scenario-receipts.json> <prefix>
"""
import json
import re
import sys

showcase, scenario_file, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
acct = lambda name: f"{name}-{prefix}.testnet"
rows = []


def add(label, tx, outcome, signer):
    rows.append({"label": label, "tx": tx, "outcome": outcome, "signer": signer})


def txs(name):
    return re.findall(r"tx (\w{43,44}) (ok|FAILED)", open(f"{showcase}/{name}").read())


ada, bo, dee = txs("2-ada.log"), txs("2-bo.log"), txs("2-dee.log")
add("Showcase: Ada creates/joins tier A and pledges 4", ada[0][0], "ok", acct("ada"))
add("Showcase: Bo creates/joins tier A and pledges 6", bo[0][0], "ok", acct("bo"))
for who, log in (("Ada", ada), ("Bo", bo)):
    if len(log) > 1:
        tx, status = log[1]
        if status == "ok":
            add(f"Showcase: {who} settles at 10/10; seller paid once", tx, "ok: Paid", acct(who.lower()))
        else:
            add(f"Showcase: {who}'s settle a moment later", tx, "rejected: deal is not open", acct(who.lower()))
add("Showcase: Dee pledges 5 to tier B (min 30)", dee[0][0], "ok", acct("dee"))
add("Showcase: tier B missed; Dee reclaims her pledge", dee[1][0], "ok: refunded", acct("dee"))
redeems = re.findall(r"tx (\w{43,44}) ok", open(f"{showcase}/3-redeem.log").read())
add("Showcase: Ada redeems 4 units (0.004 NEAR fee)", redeems[0], "ok", acct("ada"))
add("Showcase: Bo redeems 6 units (0.004 NEAR fee)", redeems[1], "ok", acct("bo"))
for i, tx in enumerate(re.findall(r"confirm_delivery tx (\w{43,44}) ok", open(f"{showcase}/4-fulfil.log").read())):
    add(f"Showcase: seller delivers pass {i} and records its sha256", tx, "ok", acct("seller"))

rec = json.load(open(scenario_file))
run = [r for r in rec["runs"] if len(r["scenarios"]) >= 9][-1]
found = []


def walk(o, sid, title):
    if isinstance(o, dict):
        if isinstance(o.get("hash"), str) and len(o["hash"]) > 40 and o["hash"] not in found:
            found.append(o["hash"])
            out = "ok" if o.get("ok") else "rejected"
            err = str(o.get("error", ""))
            for k in ["already pledged", "deadline passed", "minimum not reached", "deal is not open",
                      "refunds are not open", "nothing to refund", "storage not funded"]:
                if k in err:
                    out = "rejected: " + k
            label = f"Scenario {sid}: {title}" + (f" ({o['label']})" if o.get("label") else "")
            if sid == "g" and "settle" in str(o.get("label", "")):
                out = "ok: PayoutFailed (transfer to missing seller failed)"
            add(label, o["hash"], out, o.get("signer"))
        for v in o.values():
            walk(v, sid, title)
    elif isinstance(o, list):
        for v in o:
            walk(v, sid, title)


for s in sorted(run["scenarios"], key=lambda s: s["id"]):
    walk(s, s["id"], s["title"])
missing = [r for r in rows if not r["signer"]]
assert not missing, missing
doc = {"network": "testnet", "codeHash": run["codeHash"], "scenarioRun": run["runId"], "rows": rows}
for path in ("evidence/testnet/receipts.json", "page/receipts.json"):
    json.dump(doc, open(path, "w"), indent=1)
print(len(rows), "rows;", sorted({r["outcome"] for r in rows}))
