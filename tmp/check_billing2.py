import psycopg2
conn = psycopg2.connect(host="localhost", dbname="dgs", user="dgs", password="dgs")
cur = conn.cursor()

# VERSION 1: Check the exact floor_id from q98 floor 2
FLOOR_ID = 't_1782911133606_wdpcnj_L'

# How many idempotency keys match this floor?
cur.execute("SELECT COUNT(*) FROM idempotency_keys WHERE key LIKE %s", ('%' + FLOOR_ID + '%',))
ik_count = cur.fetchone()[0]
print(f"Idempotency keys matching '{FLOOR_ID}': {ik_count}")

# How many ai_turn transactions reference this floor?
cur.execute("""
    SELECT COUNT(*) FROM transactions t
    WHERE t.tx_type = 'ai_turn'
      AND (t.ref_type LIKE %s OR t.description LIKE %s)
""", ('%' + FLOOR_ID + '%', '%' + FLOOR_ID + '%'))
tx_count = cur.fetchone()[0]
print(f"Transactions referencing '{FLOOR_ID}': {tx_count}")

# VERSION 2: Check how many floors had MULTIPLE houses
# For each distinct floor_id in idempotency_keys, check how many billing events per floor
# in the journal logs (we can't do this via DB, but we can check idempotency keys)
cur.execute("""
    SELECT SUBSTRING(key FROM 30) as floor_part
    FROM idempotency_keys
    ORDER BY floor_part
""")
floor_parts = [r[0] for r in cur.fetchall()]

# Extract the base floor key (before any suffix like :unified or :rebuild)
import re
base_floors = {}
for fp in floor_parts:
    base = re.sub(r':(unified|rebuild|compact)$', '', fp)
    base_floors[base] = base_floors.get(base, 0) + 1

multi = {k: v for k, v in base_floors.items() if v > 1}
total_unique = len(base_floors)
print(f"\nTotal unique floor_ids: {total_unique}")
print(f"Floors with multiple idempotency key entries (compressed/rebuild): {len(multi)} of {total_unique}")
for k, v in list(multi.items())[:10]:
    print(f"  {k[:55]}: {v} entries")

# VERSION 3: Direct proof - match journald billing vs actual charges
# Count ai_turn charges today (should match unique floors, not total houses)
cur.execute("""
    SELECT COUNT(*) FROM transactions t
    WHERE t.tx_type = 'ai_turn'
      AND t.created_at > '2026-07-01 00:00:00+00'
""")
today_charges = cur.fetchone()[0]
print(f"\nai_turn transactions today: {today_charges}")
print(f"idempotency_keys today (distinct floor_parts): {total_unique}")
print(f"(These two numbers should be similar if my theory is correct)")

# VERSION 4: What are the tx ref_type values?
cur.execute("""
    SELECT t.ref_type, t.created_at, t.summary
    FROM transactions t
    WHERE t.tx_type = 'ai_turn'
      AND t.created_at > '2026-07-01 12:00:00+00'
    ORDER BY t.created_at DESC
    LIMIT 10
""")
print(f"\n=== Recent ai_turn transactions ===")
for row in cur.fetchall():
    ref = (row[0] or '')[:80]
    summary = (row[1].strftime('%H:%M:%S') if row[1] else '') + ' ' + (row[2] or '')[:60]
    print(f"  ref_type={ref}... {summary}")

# VERSION 5: Check if the billing we saw in journald (t_1782914886146_2son3y_L) has
# how many actual charges vs how many billing events
cur.execute("""
    SELECT COUNT(*) FROM transactions t
    WHERE t.tx_type = 'ai_turn'
      AND t.created_at > '2026-07-01 00:00:00+00'
      AND (t.ref_type LIKE '%t_1782914886146_2son3y_L%' OR t.description LIKE '%t_1782914886146_2son3y_L%')
""")
specific_floor_count = cur.fetchone()[0]
print(f"\nCharges for floor 't_1782914886146_2son3y_L': {specific_floor_count}")
print(f"(We saw 6 billing events in journald for this floor)")

conn.close()
