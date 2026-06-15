import sqlite3, json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
db = sqlite3.connect("qqq/alphal/quest.sq3")
row = db.execute("SELECT value FROM state WHERE key='floor.q76.79'").fetchone()
if row:
    v = json.loads(row[0])
    houses = v.get("houses", [])
    print(f"Houses count: {len(houses)}")
    for i, h in enumerate(houses):
        t = h.get("type", "?")
        idx = h.get("index", "?")
        tools = h.get("tools", [])
        ms = h.get("ms", 0)
        summary = str(h.get("summary", ""))[:100]
        answer = str(h.get("answer", ""))[:200]
        print(f"  House {i}: type={t} index={idx} ms={ms} tools={len(tools)}")
        if answer: print(f"    answer={answer[:150]}")
else:
    print("Floor 79 not found")
db.close()
