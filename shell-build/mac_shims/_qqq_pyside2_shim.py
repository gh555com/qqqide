# -*- coding: utf-8 -*-
# _qqq_pyside2_shim.py — qqqide macOS PySide2 → PySide6 透明垫片
# 由 site-packages/_qqq_pyside2_shim.pth 在解释器启动时自动加载（仅 darwin 生效）。
#
# 机制: meta_path finder 惰性映射 PySide2[*] → PySide6[*]（不 import 者零开销，
#       绝不提前导入 PySide6）+ 常用 API 差异就地补丁。
# 背景: mac 运行时只有 PySide6（PySide2 全系无 arm64 原生轮子，末版 5.15.2.1 仅 intel）；
#       goods 源码保持 PySide2 写法零改动 —— Windows 侧完全不受影响（本垫片仅 darwin 激活）。
# 覆盖的 PySide6 差异（2026-09-16 VM 实测）:
#   - QtWidgets.QDesktopWidget   缺失 → 兼容类（availableGeometry/screenGeometry/screenCount…）
#   - QtWidgets.QAction/QShortcut 位移至 QtGui → 别名
#   - QFontMetrics.width          缺失（改用 horizontalAdvance）→ 回填
#   - QPalette.Background/Foreground 缺失（Window/WindowText）→ 别名

import sys


def _install():
    if sys.platform != 'darwin':
        return
    if 'PySide2' in sys.modules:
        return
    import importlib.util
    from importlib.machinery import PathFinder
    try:
        # 真 PySide2 若在位 → 不垫（PathFinder 绕过 meta_path，防自匹配）
        if PathFinder.find_spec('PySide2') is not None:
            return
    except Exception:
        pass
    try:
        if PathFinder.find_spec('PySide6') is None:
            return
    except Exception:
        return

    class _Loader:
        def create_module(self, spec):
            import importlib
            real = 'PySide6' + spec.name[len('PySide2'):]
            mod = importlib.import_module(real)
            try:
                mod.__dict__['__qqq_shim_saved__'] = (
                    mod.__dict__.get('__spec__'), mod.__dict__.get('__loader__'))
            except Exception:
                pass
            sys.modules[spec.name] = mod
            try:
                _patch(spec.name, mod)
            except Exception:
                pass
            return mod

        def exec_module(self, module):
            # 还原 import 机制强改的 __spec__/__loader__（同一对象双名引用，防身份污染）
            saved = module.__dict__.pop('__qqq_shim_saved__', None)
            if saved:
                spec, loader = saved
                try:
                    if spec is not None:
                        module.__spec__ = spec
                except Exception:
                    pass
                try:
                    if loader is not None:
                        module.__loader__ = loader
                except Exception:
                    pass

    class _Finder:
        def find_spec(self, fullname, path=None, target=None):
            if fullname == 'PySide2' or fullname.startswith('PySide2.'):
                import importlib.util as _u
                real = 'PySide6' + fullname[len('PySide2'):]
                try:
                    if _u.find_spec(real) is None:
                        return None
                except Exception:
                    return None
                return _u.spec_from_loader(fullname, _Loader())
            return None

    sys.meta_path.insert(0, _Finder())


def _patch(name, mod):
    """把 PySide6 模块就地补成 PySide2 兼容面（只补缺失，不覆盖既有）。"""
    tail = name.split('.')[-1]
    if tail == 'QtWidgets':
        import importlib
        gui = importlib.import_module('PySide6.QtGui')
        for attr in ('QAction', 'QShortcut'):
            if not hasattr(mod, attr) and hasattr(gui, attr):
                try:
                    setattr(mod, attr, getattr(gui, attr))
                except Exception:
                    pass
        if not hasattr(mod, 'QDesktopWidget'):
            try:
                setattr(mod, 'QDesktopWidget', _DesktopWidgetCompat)
            except Exception:
                pass
    elif tail == 'QtGui':
        fm = getattr(mod, 'QFontMetrics', None)
        if fm is not None and not hasattr(fm, 'width') and hasattr(fm, 'horizontalAdvance'):
            try:
                fm.width = lambda self, *a, **k: self.horizontalAdvance(*a, **k)
            except Exception:
                pass
        pal = getattr(mod, 'QPalette', None)
        if pal is not None:
            if not hasattr(pal, 'Background') and hasattr(pal, 'Window'):
                try:
                    pal.Background = pal.Window
                except Exception:
                    pass
            if not hasattr(pal, 'Foreground') and hasattr(pal, 'WindowText'):
                try:
                    pal.Foreground = pal.WindowText
                except Exception:
                    pass


class _DesktopWidgetCompat(object):
    """Qt6 移除 QDesktopWidget — 垫片还原常用面（availableGeometry/screenGeometry…）"""

    def _screen(self, *args):
        from PySide6.QtWidgets import QApplication
        app = QApplication.instance()
        if app is None:
            return None
        screens = app.screens() or []
        if args:
            try:
                idx = int(args[0])
                if 0 <= idx < len(screens):
                    return screens[idx]
            except Exception:
                pass
        return app.primaryScreen()

    def availableGeometry(self, *args):
        from PySide6.QtCore import QRect
        scr = self._screen(*args)
        return scr.availableGeometry() if scr is not None else QRect(0, 0, 0, 0)

    def screenGeometry(self, *args):
        from PySide6.QtCore import QRect
        scr = self._screen(*args)
        return scr.geometry() if scr is not None else QRect(0, 0, 0, 0)

    def primaryScreen(self):
        return 0

    def screenCount(self):
        from PySide6.QtWidgets import QApplication
        app = QApplication.instance()
        return len(app.screens()) if app is not None else 0

    def isVirtualDesktop(self):
        return False

    def width(self):
        return self.availableGeometry().width()

    def height(self):
        return self.availableGeometry().height()


_install()
