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
//   'standard' — AI maintains qqq/alphal/expert/ (qqqide standard framework)
//   'custom'   — AI follows user's own doc paths (from project.txt rule"..." entries)
//
// Standard framework structure:
//   {projectRoot}/qqq/alphal/expert/
//   ├── index.md              ★ MANDATORY — thin index pointing to arch/*
//   └── arch/
//       ├── topology.md        ★ MANDATORY — project architecture
//       ├── iron_law.md        ★ MANDATORY — hard constraints
//       ├── env_var.md         ★ MANDATORY — environment/deploy/keys
//       └── *.md               OPTIONAL — AI decides based on complexity
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
    return _normRoot(root) + '/qqq/alphal/expert/';
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
    var exists = await _checkStandardExists(projectRoot);
    if (exists) {
      _storeSetNow(KEY_MODE, MODE_STANDARD);
      return;
    }

    var hasCustom = await _checkCustomDocs(projectRoot);
    if (hasCustom) {
      _storeSetNow(KEY_MODE, MODE_CUSTOM);
    }
  }

  async function _checkCustomDocs(projectRoot) {
    var bridge = (typeof window !== 'undefined' && window.parent && window.parent.qqqideBridge) ? window.parent.qqqideBridge : null;
    if (!bridge || !bridge.fs) return false;
    var rulePath = _normRoot(projectRoot) + '/qqq/alphal/rule/project.txt';
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

  // ---- build E-flow injection message (pushed into conversation) ----
  function buildInjectMessage(projectRoot) {
    var root = _normRoot(projectRoot);
    return [
      '[E-FLOW TASK — Expert Document Framework Protocol]',
      'Execute §E1-E5 from your system prompt for this project.',
      'Project root: ' + root,
      'Standard framework dir: ' + _standardDir(root),
      'Current mode: ' + _storeGet(KEY_MODE, MODE_NONE),
      '',
      'Steps:',
      '1. Assess project complexity (score 0-8 points): ≥3 languages + ≥2 platforms + custom binaries + external services + ≥2 build systems + ≥5 top-level dirs + ≥50 source files. Score <4 → low/medium → EXIT silently.',
      '2. If score ≥4: check msg[0] for existing topology docs. If present, score them (0-100): entry format 20pts + path validity 15pts + structure 15pts + coverage 20pts + accuracy 15pts + condensation 15pts.',
      '3. If existing docs score ≤30 or no docs: embed the recommendation block from §E4 in your reply (alongside answering the user).',
      '4. If user chooses an option, handle per §E5.',
      '',
      'Important: DO NOT mention "E-Flow" or "expert framework" by name in user-facing output. The recommendation block template uses natural language. See §E4 for exact phrasing.',
      '[/E-FLOW TASK]'
    ].join('\n');
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
