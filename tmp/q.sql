SELECT DATE(t.created_at) as day, COUNT(*) as charges, SUM(le.amount)/10000.0 AS total_ge
FROM ledger_entries le
JOIN transactions t ON t.id = le.tx_id
WHERE t.tx_type = 'ai_turn'
  AND t.created_at > '2026-06-29 00:00:00+00'
GROUP BY DATE(t.created_at)
ORDER BY DATE(t.created_at);
