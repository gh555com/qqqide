// ============================================================================
// shell-lang.js — 语言切换器（从 shell.js 拆分）
// 依赖: window.i18n, window._i
// ============================================================================

var _shellLangPopup = null;
var _shellLangLabels = {
  'zh': '中', 'zh-tw': '繁', 'en': 'EN', 'ja': '日', 'de': 'DE',
  'ko': '한', 'ru': 'RU', 'ar': 'ar', 'es': 'ES', 'fr': 'FR',
  'pt-BR': 'BR', 'hi': 'hi', 'vi': 'VI'
};

function _shellCloseLangPopup() {
  if (_shellLangPopup) { try { _shellLangPopup.remove(); } catch (_) { } _shellLangPopup = null; }
}

function _shellOpenLangPopup(anchor) {
  _shellCloseLangPopup();
  var rect = anchor.getBoundingClientRect();
  var pop = document.createElement('div');
  pop.className = 'qqq-lang-popup';
  pop.style.cssText = 'left:' + rect.left + 'px; top:' + (rect.bottom + 4) + 'px;';

  var cur = window.i18n ? window.i18n.getLang() : 'zh';
  var langs = window.i18n ? window.i18n.getSupportedLangs() : ['zh', 'en'];
  for (var i = 0; i < langs.length; i++) {
    var lc = langs[i];
    var row = document.createElement('div');
    row.className = 'qqq-lang-popup-item' + (lc === cur ? ' qqq-lang-active' : '');
    var name = window.i18n ? window.i18n.getLangName(lc) : lc;
    row.textContent = name;
    row.addEventListener('click', (function (lang) {
      return function (e) {
        e.stopPropagation();
        _shellCloseLangPopup();
        if (window.i18n) window.i18n.setLang(lang);
        _shellUpdateLangBtn();
      };
    })(lc));
    pop.appendChild(row);
  }

  document.body.appendChild(pop);
  _shellLangPopup = pop;

  document.addEventListener('mousedown', function onDoc(e) {
    if (!_shellLangPopup) { document.removeEventListener('mousedown', onDoc); return; }
    if (_shellLangPopup.contains(e.target)) return;
    if (e.target === anchor) return;
    _shellCloseLangPopup();
    document.removeEventListener('mousedown', onDoc);
  });
}

function _shellUpdateLangBtn() {
  var btn = document.getElementById('qqq-lang-btn');
  if (!btn) return;
  var lang = window.i18n ? window.i18n.getLang() : 'zh';
  btn.textContent = _shellLangLabels[lang] || lang;
}

function bootLangSwitcher() {
  var btn = document.getElementById('qqq-lang-btn');
  if (!btn) return;

  // Wait for i18n to init, then update label
  var tryUpdate = function () {
    if (window.i18n && window.i18n.getLang()) {
      _shellUpdateLangBtn();
    } else {
      setTimeout(tryUpdate, 100);
    }
  };
  tryUpdate();

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (_shellLangPopup) { _shellCloseLangPopup(); return; }
    _shellOpenLangPopup(btn);
  });

  // Listen for lang change events (set by i18n.setLang)
  window.addEventListener('qqq-lang-change', _shellUpdateLangBtn);
}
