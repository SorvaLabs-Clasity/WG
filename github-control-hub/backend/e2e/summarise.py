import json,re,sys
r=json.load(open(sys.argv[1]))
ROUTE={"My work":"/my-work","Overview":"/analytics","AWS":"/aws","Alarms":"/alarms","Access":"/access","Vulnerabilities":"/dependencies","Repos":"/graph","Pull requests":"/pulls","Who knows":"/who-knows","Activity":"/activity","Admin":"/admin"}
LOCK=re.compile(r"is restricted|have not been given access|not open to you|has not granted you any",re.I)
for who,p in r["people"].items():
    shown={ROUTE[n] for n in p["nav"]}
    print(f"\n=== {who}: landed {p['landedOn']}  api={p['apiRequests']}  nav: {', '.join(p['nav']) or '(none)'}")
    for pg,d in p["pages"].items():
        base=pg.split(" ")[0].split("?")[0]
        onTab = base in shown or pg=="(home)"
        issues=[]
        for x in d["failed"]:
            # A tab this person is not offered, opened by address: its page may
            # fire before the door or the AWS-only redirect settles. Expected.
            if not onTab and (" 403 " in f" {x} " or "GITHUB_NOT_HERE" in x): continue
            issues.append("failed: "+x[:140])
        for x in d["crashes"]: issues.append("CRASH: "+x)
        for x in d["text"]:
            if LOCK.search(x) and (not onTab or who=="ned"): continue
            issues.append("text: "+x[:140])
        issues+=["console: "+c[:120] for c in d["console"] if "Failed to load resource" not in c]
        if issues:
            print(f"  {pg}{'' if onTab else '  (not their tab)'}")
            for i in sorted(set(issues))[:6]: print("     "+i)
