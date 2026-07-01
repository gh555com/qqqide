import psycopg2
conn = psycopg2.connect(host="localhost", dbname="dgs", user="dgs", password="dgs")
cur = conn.cursor()

# Check distinct floor_id parts vs count
cur.execute("""
    SELECT SUBSTRING(key FROM 30) as floor_part, COUNT(*) as cnt
    FROM idempotency_keys
    GROUP BY floor_part
    ORDER BY cnt DESC
    LIMIT 20
""")
print("=== Idempotency keys with same floor_id ===")
for row in cur.fetchall():
    print(f"  floor_part={row[0][:60]}... count={row[1]}")

# Check today's charges
cur.execute("""
    SELECT t.tx_type, DATE(t.created_at), COUNT(*), SUM(le.amount)/10000.0
    FROM ledger_entries le
    JOIN transactions t ON t.id = le.tx_id
    WHERE t.tx_type IN ('ai_turn', 'ai_turn_free')
      AND t.created_at > '2026-07-01 00:00:00+00'
      AND EXISTS (SELECT 1 FROM wallets w WHERE w.id = le.wallet_id AND w.doer_id = '01KK1SAAR5B53SJXGNVQWP5EB6')
    GROUP BY t.tx_type, DATE(t.created_at)
    ORDER BY t.tx_type, DATE(t.created_at)
""")
print()
print("=== Today charges for user 01KK... ===")
for row in cur.fetchall():
    print(f"  type={row[0]} date={row[1]} count={row[2]} total_ge={row[3]:.4f}")

# Check free budget usage
cur.execute("""
    SELECT DATE(created_at), COUNT(*), SUM(amount)/10000.0
    FROM doer_free_budgets
    WHERE doer_id = '01KK1SAAR5B53SJXGNVQWP5EB6'
      AND created_at > '2026-07-01 00:00:00+00'
    GROUP BY DATE(created_at)
    ORDER BY DATE(created_at)
""")
print()
print("=== Free budget usage ===")
for row in cur.fetchall():
    print(f"  date={row[0]} count={row[1]} total_ge={row[2]:.4f}")

conn.close()
