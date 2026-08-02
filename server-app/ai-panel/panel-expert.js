// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// panel-expert.js — E-Flow Engine
//
// Expert Document Framework Protocol — auto-triggered per-project doc scaffolding.
//
// Trigger: first floor of first quest (100%) / any subsequent floor (10%)
// Persistence: onlyStore (project-level only.sq3)
//
// State keys in onlyStore:
//   qqq.expert.mode          — 'none' | 'standard' | 'custom'
//   qqq.expert.floorCount     — floor counter for probability dice
//   qqq.expert.lastTriggered  — timestamp of last trigger (debounce)
//
// Framework modes:
//   'none'     — no framework active (default)
//   'standard' — AI maintains _qqq/alphal/expert/ (qqqide standard framework)
//   'custom'   — AI follows user's own doc paths (from project.txt rule"..." entries)
//
// Standard framework structure:
//   {projectRoot}/_qqq/alphal/expert/
//   ├── index.md              ★ MANDATORY — thin index pointing to arch/*
//   └── arch/
//       ├── topology.md        ★ MANDATORY — project architecture
//       ├── iron_law.md        ★ MANDATORY — hard constraints
//       ├── env_var.md         ★ MANDATORY — environment/deploy/keys
//       ├── facts.md           ★ MANDATORY — immutable key facts (identity/repo/team)
//       └── *.md               OPTIONAL — AI decides based on complexity
//
// ★ Auto-bootstrap (2026-07-18): on new projects (mode='none'), skeleton files
//   are auto-created without asking the user. AI populates them as it works.
//   This ensures every project has a baseline doc framework.
// ============================================================================

var ExpertFlow = (function () {
  'use strict';

  // ---- persistence keys (onlyStore) ----
  var KEY_MODE = 'qqq.expert.mode';
  var KEY_FLOOR_COUNT = 'qqq.expert.floorCount';
  var KEY_LAST_TRIGGERED = 'qqq.expert.lastTriggered';

  // ---- probability ----
  var P_FIRST = 1.0;
  var P_OTHER = 0.1;

  // ---- mode values ----
  var MODE_NONE = 'none';
  var MODE_PENDING = 'pending';    // E-Flow asked, waiting for user reply (blocks re-trigger)
  var MODE_STANDARD = 'standard';
  var MODE_CUSTOM = 'custom';

  // ---- pending timeout: if user never replies, reset to 'none' on next startup ----
  var PENDING_TIMEOUT_MS = 60 * 60 * 1000;  // 1 hour

  // ---- debounce: don't trigger again within 5 minutes ----
  var DEBOUNCE_MS = 5 * 60 * 1000;

  // ---- helpers ----
  function _normRoot(root) {
    return (root || '').replace(/\\/g, '/').replace(/\/$/, '');
  }

  function _standardDir(root) {
    return _normRoot(root) + '/_qqq/alphal/expert/';
  }

  function _storeGet(key, fallback) {
    try {
      if (typeof onlyStore !== 'undefined' && onlyStore.isInited()) {
        return onlyStore.get(key, fallback);
      }
    } catch (e) { /* silent */ }
    return fallback;
  }

  function _storeSet(key, value) {
    try {
      if (typeof onlyStore !== 'undefined' && onlyStore.isInited()) {
        onlyStore.set(key, value);
      }
    } catch (e) { /* silent */ }
  }

  function _storeSetNow(key, value) {
    try {
      if (typeof onlyStore !== 'undefined' && onlyStore.isInited()) {
        onlyStore.setNow(key, value);
      }
    } catch (e) { /* silent */ }
  }

  // ---- determine if E-flow should trigger ----
  // @param isFirstQuestInProject — true if this is the very first quest created
  // @param floorNum — 1-based floor number
  //
  // Gate logic:
  //   mode='none' (default for new projects) → FALLS THROUGH → probability check runs
  //   mode='standard' or 'custom' → BLOCKED (user already chose a framework)
  //   This is CORRECT: 'none' means "undecided", so we ask. Only 'standard'/'custom' skip.
  function shouldTrigger(isFirstQuestInProject, floorNum) {
    // BLOCK trigger when: user chose a framework ('standard'/'custom') OR we already asked and are waiting for reply ('pending')
    var mode = _storeGet(KEY_MODE, MODE_NONE);
    if (mode === MODE_STANDARD || mode === MODE_CUSTOM || mode === MODE_PENDING) return false;
    // mode='none' passes through

    // Debounce: don't trigger if we triggered recently
    var last = _storeGet(KEY_LAST_TRIGGERED, 0);
    if (Date.now() - last < DEBOUNCE_MS) return false;

    // First floor of first quest: always (100%)
    if (isFirstQuestInProject && floorNum === 1) return true;

    // All other floors: 10% random
    var count = _storeGet(KEY_FLOOR_COUNT, 0);
    _storeSet(KEY_FLOOR_COUNT, count + 1);

    // Use floor count as seed for more even distribution
    // (every ~10th floor on average, but random)
    return Math.random() < P_OTHER;
  }

  // ---- mark as triggered (debounce) ----
  function markTriggered() {
    _storeSetNow(KEY_LAST_TRIGGERED, Date.now());
  }

  // ---- get/set framework mode ----
  function getMode() {
    return _storeGet(KEY_MODE, MODE_NONE);
  }

  function setMode(mode) {
    if (mode === MODE_STANDARD || mode === MODE_CUSTOM || mode === MODE_NONE || mode === MODE_PENDING) {
      _storeSetNow(KEY_MODE, mode);
    }
  }

  // ---- auto-detect: check state on startup and after each floor ----
  async function autoDetect(projectRoot) {
    if (!projectRoot) return;
    var mode = _storeGet(KEY_MODE, MODE_NONE);

    // ★ If mode is 'standard' or 'custom', framework is settled — nothing to do
    if (mode === MODE_STANDARD || mode === MODE_CUSTOM) return;

    // ★ If mode is 'pending': we already asked the user, waiting for reply.
    //   But check if the AI has already created framework files in THIS floor —
    //   if so, upgrade to the appropriate settled mode immediately.
    if (mode === MODE_PENDING) {
      var exists = await _checkStandardExists(projectRoot);
      if (exists) {
        _storeSetNow(KEY_MODE, MODE_STANDARD);
        return;
      }
      var hasCustom = await _checkCustomDocs(projectRoot);
      if (hasCustom) {
        _storeSetNow(KEY_MODE, MODE_CUSTOM);
        return;
      }
      // No files yet — check if pending has timed out
      var last = _storeGet(KEY_LAST_TRIGGERED, 0);
      if (Date.now() - last > PENDING_TIMEOUT_MS) {
        _storeSetNow(KEY_MODE, MODE_NONE);  // timeout → re-ask next session
      }
      return;
    }

    // mode === 'none': initial auto-detection at startup
    // ★ Auto-bootstrap (2026-07-18): create skeleton expert framework for new projects
    //   so every project has a baseline doc structure (including facts.md).
    //   AI populates the skeleton files as it works on the project.
    var bootstrapped = await _bootstrapStandardFramework(projectRoot);
    if (bootstrapped) {
      _storeSetNow(KEY_MODE, MODE_STANDARD);
      return;
    }

    var hasCustom = await _checkCustomDocs(projectRoot);
    if (hasCustom) {
      _storeSetNow(KEY_MODE, MODE_CUSTOM);
    }
  }

  // ---- skeleton templates (minimal placeholders, AI populates later) ----
  function _skeletonIndex(projectName, projectRoot) {
    return '# Expert Index — ' + projectName + '\n'
      + '> Thin lookup index. Points to arch/*.md files.\n'
      + '> Injected into msg[0] via rule"..." in project.txt.\n'
      + '> Keep it lean.\n'
      + '\n'
      + '## Project Identity\n'
      + '- Name: ' + projectName + '\n'
      + '- Type: {project_type}\n'
      + '- Stack: {tech_stack}\n'
      + '\n'
      + '## Subsystem Map\n'
      + '\n'
      + '| Subsystem | File | Summary |\n'
      + '|-----------|------|---------|\n'
      + '| Topology | [topology.md](arch/topology.md) | Project architecture, directory structure |\n'
      + '| Iron Laws | [iron_law.md](arch/iron_law.md) | Unbreakable hard constraints |\n'
      + '| Env & Deploy | [env_var.md](arch/env_var.md) | Environment variables, keys, servers |\n'
      + '| Facts | [facts.md](arch/facts.md) | Identity, repo, team, key decisions |\n'
      + '\n'
      + '## Quick Reference\n'
      + '- Architecture → topology.md\n'
      + '- Violation risk → iron_law.md\n'
      + '- Secrets/servers/deploy → env_var.md\n'
      + '- Project identity/repo/team → facts.md\n'
      + '\n'
      + '```\n'
      + 'rule"' + projectRoot + '/_qqq/alphal/expert/index.md"\n'
      + '```\n';
  }

  function _skeletonTopology(projectName) {
    return '# Topology — ' + projectName + ' Architecture\n'
      + '> Condensed reference. AI-maintained. Update when architecture changes.\n'
      + '\n'
      + '## Architecture Overview\n'
      + '<!-- Layer model, component diagram, data flow — AI fills in -->\n'
      + '\n'
      + '## Directory Structure\n'
      + '<!-- Key directories and their roles -->\n'
      + '\n'
      + '## Key Pipelines\n'
      + '<!-- Build, deploy, data flow pipelines -->\n'
      + '\n'
      + '## Persistence\n'
      + '<!-- Storage layers, databases, file formats -->\n'
      + '\n'
      + '## Key Constants\n'
      + '<!-- Timeouts, limits, thresholds that affect behavior -->\n';
  }

  function _skeletonIronLaw(projectName) {
    return '# Iron Laws — ' + projectName + '\n'
      + '> Unbreakable hard constraints. Violating any § = guaranteed rework.\n'
      + '> One fact per line. No storytelling.\n'
      + '\n'
      + '## §0 Document Discipline\n'
      + '- Minimal. Only conclusions. All docs <4000 tokens.\n'
      + '- One fact = one place.\n'
      + '\n'
      + '## §1 Naming\n'
      + '<!-- AI fills: naming conventions, forbidden patterns -->\n'
      + '\n'
      + '## §2 Architecture Layers\n'
      + '<!-- AI fills: layer boundaries, responsibilities -->\n'
      + '\n'
      + '## §3 Build & Deploy\n'
      + '<!-- AI fills: build system, deploy flow, must-not-do rules -->\n'
      + '\n'
      + '## §4 Persistence\n'
      + '<!-- AI fills: data storage rules, atomicity requirements -->\n'
      + '\n'
      + '## §5 Version Lock\n'
      + '<!-- AI fills: locked dependency versions and why -->\n';
  }

  function _skeletonEnvVar(projectName) {
    return '# Environment Variables & Deployment — ' + projectName + '\n'
      + '> Server access, API keys, deploy scripts.\n'
      + '> ⚠️ May contain sensitive information.\n'
      + '\n'
      + '## Servers\n'
      + '<!-- AI fills: IPs, roles, access methods -->\n'
      + '\n'
      + '## Deploy Scripts\n'
      + '<!-- AI fills: scripts, locations, purposes -->\n'
      + '\n'
      + '## Ports\n'
      + '<!-- AI fills: dev and production ports -->\n'
      + '\n'
      + '## Environment Variables\n'
      + '<!-- AI fills: key .env variables and their purposes -->\n'
      + '\n'
      + '## Build Commands\n'
      + '<!-- AI fills: build, test, deploy commands -->\n'
      + '\n'
      + '## Deploy Flow\n'
      + '<!-- AI fills: step-by-step deploy pipeline -->\n';
  }

  function _skeletonFacts(projectName) {
    return '# Facts — ' + projectName + '\n'
      + '> Immutable key facts. One fact per line. AI-maintained.\n'
      + '\n'
      + '## Identity\n'
      + '- Purpose: {project_purpose}\n'
      + '- Primary Language: {primary_language}\n'
      + '\n'
      + '## Repository\n'
      + '- URL: {repo_url}\n'
      + '\n'
      + '## Team & Access\n'
      + '<!-- Key personnel, access methods -->\n'
      + '\n'
      + '## Key Decisions\n'
      + '<!-- One-time architectural/technical decisions -->\n'
      + '\n'
      + '## External Dependencies\n'
      + '<!-- APIs, services, critical libraries -->\n'
      + '\n'
      + '## Quick Notes\n'
      + '<!-- Anything else important -->\n';
  }

  // ---- auto-bootstrap: create skeleton expert framework for new projects ----
  async function _bootstrapStandardFramework(projectRoot) {
    var bridge = (typeof window !== 'undefined' && window.parent && window.parent.qqqideBridge) ? window.parent.qqqideBridge : null;
    if (!bridge || !bridge.fs) return false;

    var root = _normRoot(projectRoot);
    var expertDir = root + '/_qqq/alphal/expert/';
    var archDir = expertDir + 'arch/';
    var projectName = root.split('/').pop() || 'unknown';

    // Already bootstrapped? Check index.md existence
    try {
      var stat = await bridge.fs.stat(expertDir + 'index.md');
      if (stat && !stat.isDir) return true;
    } catch (_) { /* not yet */ }

    // Create directories
    try { await bridge.fs.mkdir(expertDir); } catch (_) { }
    try { await bridge.fs.mkdir(archDir); } catch (_) { }

    // Write skeleton files (best-effort, don't fail if one fails)
    try { await bridge.fs.write(expertDir + 'index.md', _skeletonIndex(projectName, root)); } catch (_) { }
    try { await bridge.fs.write(archDir + 'topology.md', _skeletonTopology(projectName)); } catch (_) { }
    try { await bridge.fs.write(archDir + 'iron_law.md', _skeletonIronLaw(projectName)); } catch (_) { }
    try { await bridge.fs.write(archDir + 'env_var.md', _skeletonEnvVar(projectName)); } catch (_) { }
    try { await bridge.fs.write(archDir + 'facts.md', _skeletonFacts(projectName)); } catch (_) { }

    // Register in project.txt so rule"..." loading picks up index.md
    await _registerProjectRule(root, expertDir + 'index.md');

    return true;
  }

  // ---- append rule"..." line to project.txt if not already present ----
  async function _registerProjectRule(projectRoot, indexPath) {
    var bridge = (typeof window !== 'undefined' && window.parent && window.parent.qqqideBridge) ? window.parent.qqqideBridge : null;
    if (!bridge || !bridge.fs) return;

    var rulePath = projectRoot + '/_qqq/alphal/rule/project.txt';
    var ruleLine = 'rule"' + indexPath.replace(/\\/g, '/') + '"';

    try {
      var existing = await bridge.fs.read(rulePath);
      if (existing && existing.indexOf(ruleLine) !== -1) return; // already registered
    } catch (_) { /* file doesn't exist yet */ }

    // Ensure directory exists
    var ruleDir = projectRoot + '/_qqq/alphal/rule/';
    try { await bridge.fs.mkdir(ruleDir); } catch (_) { }

    var newContent = (existing ? existing.trim() + '\n' : '') + ruleLine + '\n';
    try { await bridge.fs.write(rulePath, newContent); } catch (_) { }
  }

  async function _checkCustomDocs(projectRoot) {
    var bridge = (typeof window !== 'undefined' && window.parent && window.parent.qqqideBridge) ? window.parent.qqqideBridge : null;
    if (!bridge || !bridge.fs) return false;
    var rulePath = _normRoot(projectRoot) + '/_qqq/alphal/rule/project.txt';
    try {
      var text = await bridge.fs.read(rulePath);
      if (text && text.trim()) {
        // Check for rule"..." entries (user-defined topology docs)
        return /rule"[^"]+"/.test(text);
      }
    } catch (e) { /* silent */ }
    return false;
  }

  async function _checkStandardExists(projectRoot) {
    var bridge = (typeof window !== 'undefined' && window.parent && window.parent.qqqideBridge) ? window.parent.qqqideBridge : null;
    if (!bridge || !bridge.fs) return false;
    var idxPath = _standardDir(projectRoot) + 'index.md';
    try {
      var stat = await bridge.fs.stat(idxPath);
      return !!(stat && !stat.isDir);
    } catch (e) {
      return false;
    }
  }

  // ---- build E-flow injection message — single-line trigger, full protocol lives in server shell ----
  function buildInjectMessage(projectRoot) {
    return '[E-FLOW trigger]';
  }

  // ---- check if project has custom docs (rule"..." entries in project.txt) ----
  function hasCustomDocs() {
    return getMode() === MODE_CUSTOM;
  }

  function hasStandardFramework() {
    return getMode() === MODE_STANDARD;
  }

  // ========================================================================
  // Public API
  // ========================================================================
  return {
    shouldTrigger: shouldTrigger,
    markTriggered: markTriggered,
    getMode: getMode,
    setMode: setMode,
    autoDetect: autoDetect,
    buildInjectMessage: buildInjectMessage,
    hasCustomDocs: hasCustomDocs,
    hasStandardFramework: hasStandardFramework,

    // constants
    MODE_NONE: MODE_NONE,
    MODE_PENDING: MODE_PENDING,
    MODE_STANDARD: MODE_STANDARD,
    MODE_CUSTOM: MODE_CUSTOM,
    KEY_MODE: KEY_MODE
  };
})();

// Export to window for cross-module access
window.ExpertFlow = ExpertFlow;
