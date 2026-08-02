# docs/ — Web Documentation Sources

> Maps web slugs (gh555.com/gaea/d/qqqide#docs/{slug}) to canonical local files.
> These are the source-of-truth files pushed to the web via PostgreSQL.

| Web Slug | Local File | DB Page ID | Description |
|----------|-----------|------------|-------------|
| `qqqide` | `docs/qqqide.md` | 42 | 上下文背包设计论文 (V16) |
| `qqqide-2` | `docs/qqqide-2.md` | 44 | 上下文背包操作指南 |
| `context-ownership` | `docs/context-ownership.md` | 1 | 将用户上下文及其使用权还给用户 |

## Legacy Sources (kept for reference)

| Old File | Mapped To |
|----------|-----------|
| `论文/qqqide滴上下文背包设计` | `docs/qqqide.md` |
| `do/功能/qqqide 滴上下文背包操作.md` | `docs/qqqide-2.md` |
| `论文/将用户上下文及其使用权还给用户.md` | `docs/context-ownership.md` |

## How to Push

Update PostgreSQL directly:
```sql
UPDATE doc_pages SET content = '{escaped_content}', updated_at = now() WHERE id = {page_id};
```

Or use the web admin UI at `#docs-admin`.
