# Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

#!/usr/bin/env python3
"""Convert Monaco ESM files to AMD define() format for Worker importScripts.

Walks esm/vs/ directory, converts each .js file from ES module to AMD format,
writes output to cache/monaco-deps/vs/.
"""

import os, re, sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ESM_ROOT = os.path.join(PROJECT_ROOT, 'node_modules', 'monaco-editor', 'esm', 'vs')
OUT_ROOT = os.path.join(PROJECT_ROOT, 'cache', 'monaco-deps', 'vs')

# Match an import statement (possibly multi-line)
IMPORT_RE = re.compile(
    r'import\s*'
    r'((?:\{[^}]*\})|(?:\*\s*as\s+\w+)|(?:\w+))\s*'
    r'from\s*'
    r"['\"]([^'\"]+)['\"]\s*;?",
    re.MULTILINE | re.DOTALL
)

def module_id(rel):
    """vs/base/common/strings.js -> vs/base/common/strings"""
    return 'vs/' + rel.replace('\\', '/').replace('.js', '')

def resolve_import(base_module, rel_import):
    """Resolve relative import to absolute AMD module ID."""
    if not rel_import.startswith('.'):
        return 'vs/' + rel_import.replace('.js', '').lstrip('/')
    base_dir = '/'.join(base_module.split('/')[:-1])
    parts = base_dir.split('/')
    for p in rel_import.split('/'):
        if p == '..':
            if parts: parts.pop()
        elif p != '.':
            parts.append(p)
    return '/'.join(parts).replace('.js', '')

def convert_one(filepath, rel_path):
    """Convert single ESM file to AMD define() format."""
    with open(filepath, 'r', encoding='utf-8') as f:
        src = f.read()

    mid = module_id(rel_path)

    # -- find all imports --
    imports = []  # [(start, end, clause, path), ...]
    for m in IMPORT_RE.finditer(src):
        imports.append((m.start(), m.end(), m.group(1), m.group(2)))

    # build dep list
    seen = {'require': True, 'exports': True}
    deps = ['require', 'exports']
    dep_index = {}

    def add_dep(abs_id):
        if abs_id not in seen:
            seen[abs_id] = True
            deps.append(abs_id)
            dep_index[abs_id] = '_d' + str(len(deps) - 1)

    for _, _, clause, path in imports:
        abs_id = resolve_import(mid, path)
        add_dep(abs_id)

    # -- remove imports and replace with var declarations (reverse order) --
    out = src
    for start, end, clause, path in reversed(imports):
        abs_id = resolve_import(mid, path)
        param = dep_index[abs_id]

        if clause.startswith('* as '):
            ns = clause[5:].strip()
            repl = 'var ' + ns + ' = ' + param + ';'
        elif clause.startswith('{'):
            inner = clause[1:-1]
            decls = []
            for part in inner.split(','):
                part = part.strip()
                if not part: continue
                if ' as ' in part:
                    orig, alias = part.split(' as ')
                    decls.append('var ' + alias.strip() + ' = ' + param + '.' + orig.strip() + ';')
                else:
                    decls.append('var ' + part + ' = ' + param + '.' + part + ';')
            repl = ' '.join(decls)
        else:
            repl = 'var ' + clause.strip() + ' = ' + param + '.default;'

        out = out[:start] + repl + out[end:]

    # -- convert exports line by line --
    # Strategy: process each line, build output lines
    lines = out.split('\n')
    result_lines = []

    # Patterns for exports (order matters)
    # export default function foo(...)
    re_exp_default_fn = re.compile(r'^(\s*)export\s+default\s+function\s+(\w+)(.*)', re.MULTILINE)
    # export default class Foo
    re_exp_default_cls = re.compile(r'^(\s*)export\s+default\s+class\s+(\w+)(.*)', re.MULTILINE)
    # export default expr;
    re_exp_default_val = re.compile(r'^(\s*)export\s+default\s+(.+);?\s*$', re.MULTILINE)
    # export function foo(...)
    re_exp_fn = re.compile(r'^(\s*)export\s+function\s+(\w+)(.*)', re.MULTILINE)
    # export function* foo(...)
    re_exp_fn_star = re.compile(r'^(\s*)export\s+function\*\s+(\w+)(.*)', re.MULTILINE)
    # export class Foo
    re_exp_cls = re.compile(r'^(\s*)export\s+class\s+(\w+)(.*)', re.MULTILINE)
    # export const/let/var X = expr;
    re_exp_var = re.compile(r'^(\s*)export\s+(const|let|var)\s+(\w+)(.*)', re.MULTILINE)
    # export { A, B };
    re_exp_braces = re.compile(r'^(\s*)export\s+\{([^}]*)\}\s*;?\s*$', re.MULTILINE)

    i = 0
    while i < len(lines):
        line = lines[i]

        def matched(m):
            return m and m.span()[0] == 0  # matches from start of line

        m = re_exp_default_fn.match(line)
        if matched(m):
            indent, name, rest = m.group(1), m.group(2), m.group(3)
            result_lines.append(indent + 'exports.default = function ' + name + rest)
            i += 1
            continue

        m = re_exp_default_cls.match(line)
        if matched(m):
            indent, name, rest = m.group(1), m.group(2), m.group(3)
            result_lines.append(indent + 'exports.default = class ' + name + rest)
            i += 1
            continue

        m = re_exp_default_val.match(line)
        if matched(m):
            indent, expr = m.group(1), m.group(2)
            result_lines.append(indent + 'exports.default = ' + expr + ';')
            i += 1
            continue

        m = re_exp_fn.match(line)
        if matched(m):
            indent, name, rest = m.group(1), m.group(2), m.group(3)
            result_lines.append(indent + 'exports.' + name + ' = function ' + name + rest)
            i += 1
            continue

        m = re_exp_fn_star.match(line)
        if matched(m):
            indent, name, rest = m.group(1), m.group(2), m.group(3)
            result_lines.append(indent + 'exports.' + name + ' = function* ' + name + rest)
            i += 1
            continue

        m = re_exp_cls.match(line)
        if matched(m):
            indent, name, rest = m.group(1), m.group(2), m.group(3)
            result_lines.append(indent + 'exports.' + name + ' = class ' + name + rest)
            i += 1
            continue

        m = re_exp_var.match(line)
        if matched(m):
            indent, keyword, name, rest = m.group(1), m.group(2), m.group(3), m.group(4)
            # Keep the original declaration but add exports.Name = Name;
            result_lines.append(indent + keyword + ' ' + name + rest)
            result_lines.append(indent + 'exports.' + name + ' = ' + name + ';')
            i += 1
            continue

        m = re_exp_braces.match(line)
        if matched(m):
            # export { A, B }; -> nothing (these are re-exports, or export {})
            # Just skip the line entirely
            i += 1
            continue

        # Not an export line: keep as-is
        result_lines.append(line)
        i += 1

    out = '\n'.join(result_lines)

    # Build dep string
    dep_str = ','.join("'" + d + "'" for d in deps)
    param_str = ','.join(
        d if d in ('require', 'exports') else dep_index.get(d, '_d' + str(deps.index(d)))
        for d in deps
    )

    body = '\n'.join('\t' + ln for ln in out.split('\n'))
    return 'define("' + mid + '",[' + dep_str + '],function(' + param_str + ') {\n' + body + '\n});\n'


def main():
    if not os.path.isdir(ESM_ROOT):
        print('ERROR: ESM root missing: ' + ESM_ROOT, file=sys.stderr)
        sys.exit(1)

    os.makedirs(OUT_ROOT, exist_ok=True)

    ok = 0
    err = 0
    for dp, dns, fns in os.walk(ESM_ROOT):
        rel_dir = os.path.relpath(dp, ESM_ROOT)
        for fn in fns:
            if not fn.endswith('.js'):
                continue
            rel = os.path.join(rel_dir, fn) if rel_dir != '.' else fn
            try:
                result = convert_one(os.path.join(dp, fn), rel)
                op = os.path.join(OUT_ROOT, rel)
                os.makedirs(os.path.dirname(op), exist_ok=True)
                with open(op, 'w', encoding='utf-8') as f:
                    f.write(result)
                ok += 1
            except Exception as e:
                print('ERR ' + rel + ': ' + str(e), file=sys.stderr)
                err += 1

    print(f'Done: {ok} converted, {err} errors -> {OUT_ROOT}')

if __name__ == '__main__':
    main()
