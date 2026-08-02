#!/usr/bin/env python3
"""Push docs/ content to web (PostgreSQL on CN server).
Usage: python push_docs.py [--dry-run]
Reads docs/*.md and generates SQL UPDATE statements.
"""

import os, sys, json

DOCS_DIR = os.path.dirname(os.path.abspath(__file__))

PAGES = [
    {"slug": "qqqide", "file": "qqqide.md", "page_id": 42},
    {"slug": "qqqide-2", "file": "qqqide-2.md", "page_id": 44},
    {"slug": "context-ownership", "file": "context-ownership.md", "page_id": 1},
]

def escape_sql(s):
    """Escape for PostgreSQL dollar-quoted string."""
    # Use $$ quoting with a random tag to avoid collisions
    return s.replace("$$", "$ $")

def main():
    dry_run = "--dry-run" in sys.argv
    
    for page in PAGES:
        filepath = os.path.join(DOCS_DIR, page["file"])
        if not os.path.exists(filepath):
            print(f"SKIP {page['slug']}: file not found at {filepath}")
            continue
        
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
        
        # Find a unique dollar-quote tag
        tag = "CONTENT_TAG"
        while tag in content:
            tag = "X" + tag
        
        sql = f"""UPDATE doc_pages SET content = ${tag}${content}$${tag}$, updated_at = now() WHERE id = {page['page_id']};"""
        
        print(f"\n-- {'='*60}")
        print(f"-- {page['slug']} (page_id={page['page_id']}, {len(content)} chars)")
        print(f"-- {'='*60}")
        
        if dry_run:
            print(f"-- DRY RUN: would update page {page['page_id']} with {len(content)} chars")
        else:
            print(sql)
    
    print(f"\n-- Total: {len(PAGES)} pages")

if __name__ == "__main__":
    main()
