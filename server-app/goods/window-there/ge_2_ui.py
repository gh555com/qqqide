# Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

# ui.py (R22 更新版)
import sys
import time
from PySide2.QtWidgets import (
    QApplication, QDialog, QWidget, QScrollArea, QVBoxLayout, QHBoxLayout,
    QGridLayout, QFrame, QPushButton, QDesktopWidget, QLabel,
    QGraphicsDropShadowEffect, QSizePolicy
)
from PySide2.QtGui import (
    QFont, QPainter, QColor, QBrush, QPen, QMouseEvent, QKeyEvent, QCloseEvent
)
from PySide2.QtCore import (
    Qt, QRect, QSize, Signal, QEvent, QPoint, QTimer
)

# --- (R22) 修复 2: 导入 config 模块以解决 NameError ---
import ge_2_env as config

# R19 调色板 (豆沙红)
PALETTE = {
    "BG_MAIN": "#faf3e0",
    "BG_MAIN_PENDING": "#d9caca",
    "BG_PANEL": "#f7ecce",
    "BG_PANEL_HOVER": "#fde8d0",
    "BORDER": "#e0cda7",
    "BORDER_HIGHLIGHT": "#f57c00",
    "TEXT_DARK": "#4a4a4a",
    "TEXT_LIGHT": "#7a7a7a",
    "DELETE_HOVER_BG": "#ffcdd2",
    "DELETE_HOVER_FG": "#d32f2f",
    "DELETE_PENDING_BG": "#d32f2f",
    "DELETE_PENDING_FG": "#ffffff",
    "PREVIEW_DESKTOP": "#4a4a4a",
    "PREVIEW_WINDOW": "#ffb74d"
}

g_platform_manager = None
g_save_callback = None
g_qt_aqq_instance = None

class CustomDialog(QDialog):
    """
    (R20) NFR 9 移除: 回归标准的 Qt 弹窗激活行为
    """
    def __init__(self, title, message, buttons="ok", parent=None):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Dialog)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setModal(True)

        self.drag_pos = QPoint()

        self.bg_frame = QFrame(self)
        self.bg_frame.setObjectName("bg_frame")
        self.bg_frame.setStyleSheet(f"""
            #bg_frame {{
                background-color: {PALETTE['BG_MAIN']};
                border: 1px solid {PALETTE['BORDER']};
                border-radius: 4px;
            }}
        """)

        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.addWidget(self.bg_frame)

        content_layout = QVBoxLayout(self.bg_frame)
        content_layout.setContentsMargins(15, 10, 15, 10)
        content_layout.setSpacing(10)

        self.title_label = QLabel(title)
        font = QFont("Consolas", 11)
        font.setFamilies(["Consolas", "monospace", "LXGW WenKai GB Screen", "SF Pro", "Segoe UI", "Aptos", "Roboto", "Arial"])
        font.setBold(True)
        self.title_label.setFont(font)
        self.title_label.setStyleSheet(f"color: {PALETTE['TEXT_DARK']}; background-color: transparent;")
        content_layout.addWidget(self.title_label)

        self.message_label = QLabel(message.replace('\n', '<br>'))
        font = QFont("Consolas", 11)
        font.setFamilies(["Consolas", "monospace", "LXGW WenKai GB Screen", "SF Pro", "Segoe UI", "Aptos", "Roboto", "Arial"])
        self.message_label.setFont(font)
        self.message_label.setWordWrap(True)
        self.message_label.setMinimumWidth(350)
        self.message_label.setStyleSheet(f"color: {PALETTE['TEXT_DARK']}; background-color: transparent;")
        content_layout.addWidget(self.message_label)

        spacer = QWidget()
        spacer.setSizePolicy(QSizePolicy.Minimum, QSizePolicy.Expanding)
        content_layout.addWidget(spacer)

        button_layout = QHBoxLayout()
        button_layout.setSpacing(10)
        button_layout.addStretch()

        self.yes_button = None
        self.no_button = None
        self.ok_button = None

        btn_style = f"""
            QPushButton {{
                font-weight: bold; font-size: 10pt; padding: 8px 16px;
                border-radius: 4px; border: 1px solid {PALETTE['BORDER']};
                background-color: {PALETTE['BG_PANEL']}; color: {PALETTE['TEXT_DARK']};
            }}
            QPushButton:hover {{
                border: 1px solid {PALETTE['BORDER_HIGHLIGHT']};
                background-color: {PALETTE['BG_PANEL_HOVER']};
            }}
        """
        btn_style_default = f"""
            QPushButton {{
                font-weight: bold; font-size: 10pt; padding: 8px 16px;
                border-radius: 4px;
                border: 1px solid {PALETTE['BORDER_HIGHLIGHT']};
                background-color: {PALETTE['BG_PANEL_HOVER']};
                color: {PALETTE['TEXT_DARK']};
            }}
            QPushButton:hover {{
                border: 1px solid {PALETTE['DELETE_HOVER_FG']};
                background-color: {PALETTE['BG_PANEL_HOVER']};
            }}
        """

        if buttons == "yesno":
            confirm_text = "确认"
            if "保存" in title: confirm_text = "保存"
            if "删除" in title: confirm_text = "删除"

            self.yes_button = QPushButton(confirm_text)
            self.yes_button.setStyleSheet(btn_style_default)
            self.yes_button.clicked.connect(self.accept)
            self.yes_button.setDefault(True)

            self.no_button = QPushButton("取消")
            self.no_button.setStyleSheet(btn_style)
            self.no_button.clicked.connect(self.reject)
            self.no_button.setAutoDefault(False)

            button_layout.addWidget(self.no_button)
            button_layout.addWidget(self.yes_button)
        else:
            self.ok_button = QPushButton("确定")
            self.ok_button.setStyleSheet(btn_style_default)
            self.ok_button.clicked.connect(self.accept)
            self.ok_button.setDefault(True)
            button_layout.addWidget(self.ok_button)

        content_layout.addLayout(button_layout)
        self.setLayout(main_layout)

        qr = self.frameGeometry()
        cp = QDesktopWidget().availableGeometry().center()
        qr.moveCenter(cp)
        self.move(qr.topLeft())

        # (R20) NFR 9 移除:
        self.activateWindow()
        self.raise_()
        if self.yes_button and self.yes_button.isVisible():
            self.yes_button.setFocus(Qt.OtherFocusReason)
        elif self.ok_button and self.ok_button.isVisible():
            self.ok_button.setFocus(Qt.OtherFocusReason)

    def mousePressEvent(self, event: QMouseEvent):
        if event.button() == Qt.LeftButton:
            if event.pos().y() < 30:
                self.drag_pos = event.globalPos() - self.frameGeometry().topLeft()
                event.accept()

    def mouseMoveEvent(self, event: QMouseEvent):
        if event.buttons() == Qt.LeftButton:
            if not self.drag_pos.isNull():
                self.move(event.globalPos() - self.drag_pos)
                event.accept()

    def mouseReleaseEvent(self, event: QMouseEvent):
        self.drag_pos = QPoint()
        event.accept()

    def keyPressEvent(self, event: QKeyEvent):
        if self.yes_button and event.key() == Qt.Key_W:
            self.accept()
        elif event.key() == Qt.Key_Escape:
            self.reject()
        else:
            super().keyPressEvent(event)

def show_custom_message(title, message, buttons="ok"):
    global g_qt_aqq_instance
    if QApplication.instance() is None:
        g_qt_aqq_instance = QApplication(sys.argv)

    dialog = CustomDialog(title, message, buttons)
    result = dialog.exec_()

    return result == QDialog.Accepted

class LayoutPreviewPanel(QFrame):
    clicked = Signal(dict)
    delete_requested = Signal(dict)

    def __init__(self, layout_info, parent=None):
        super().__init__(parent)
        self.layout_info = layout_info
        self.is_hovered = False
        self.selector_window = None
        self.setFixedSize(378, 288)
        self.setMouseTracking(True)
        self.setWindowOpacity(1.0)

        self.base_style = f"LayoutPreviewPanel {{ background-color: {PALETTE['BG_PANEL']}; border: 1px solid {PALETTE['BORDER']}; border-radius: 3px; }}"
        self.hover_style = f"LayoutPreviewPanel {{ background-color: {PALETTE['BG_PANEL_HOVER']}; border: 2px solid {PALETTE['BORDER_HIGHLIGHT']}; margin: -1px; border-radius: 3px; }}"
        self.setStyleSheet(self.base_style)

        btn_size, btn_radius = 22, 11
        self.delete_btn = QPushButton("×", self)
        self.delete_btn.setFixedSize(btn_size, btn_size)
        self.delete_btn.move(self.width() - btn_size - 5, 5)
        font = QFont("Consolas", 11)
        font.setFamilies(["Consolas", "monospace", "LXGW WenKai GB Screen", "SF Pro", "Segoe UI", "Aptos", "Roboto", "Arial"])
        self.delete_btn.setFont(font)
        self.delete_btn.clicked.connect(self.on_delete_clicked)
        self.delete_btn.installEventFilter(self)

        self.delete_btn_style_normal = f"QPushButton {{ background-color: transparent; color: {PALETTE['TEXT_DARK']}; border: none; border-radius: {btn_radius}px; font-weight: bold; }} QPushButton:hover {{ background-color: {PALETTE['DELETE_HOVER_BG']}; color: {PALETTE['DELETE_HOVER_FG']}; }}"
        self.delete_btn_style_pending = f"QPushButton {{ background-color: {PALETTE['DELETE_PENDING_BG']}; color: {PALETTE['DELETE_PENDING_FG']}; border: none; border-radius: {btn_radius}px; font-weight: bold; }} QPushButton:hover {{ background-color: {PALETTE['DELETE_PENDING_BG']}; color: {PALETTE['DELETE_PENDING_FG']}; }}"
        self.delete_btn.setStyleSheet(self.delete_btn_style_normal)

        self.tooltip_label = QLabel(self)
        font = QFont("Consolas", 11)
        font.setFamilies(["Consolas", "monospace", "LXGW WenKai GB Screen", "SF Pro", "Segoe UI", "Aptos", "Roboto", "Arial"])
        self.tooltip_label.setFont(font)
        self.tooltip_label.setStyleSheet(f"color: #000000; background-color: transparent;")
        self.tooltip_label.setText(self.format_tooltip_text())
        self.tooltip_label.setAlignment(Qt.AlignLeft | Qt.AlignTop)
        self.tooltip_label.setWordWrap(True)
        self.tooltip_label.move(10, 5)
        self.tooltip_label.resize(self.delete_btn.x() - 15, 40)

        shadow_tooltip = QGraphicsDropShadowEffect(self)
        shadow_tooltip.setBlurRadius(3)
        shadow_tooltip.setColor(QColor("#FFFFFF"))
        shadow_tooltip.setOffset(0, 2)
        self.tooltip_label.setGraphicsEffect(shadow_tooltip)

        self.tooltip_label.hide()
        self.tooltip_label.raise_()

    def eventFilter(self, obj, event):
        if obj == self.delete_btn:
            if event.type() == QEvent.Enter: self.tooltip_label.show()
            elif event.type() == QEvent.Leave: self.tooltip_label.hide()
        return super().eventFilter(obj, event)

    def format_tooltip_text(self):
        try:
            title = self.layout_info.get('title', 'N/A')
            if len(title) > 58: title = title[:58] + "..."
            key_str = self.layout_info['key']
            if len(key_str) > 14: key_str = key_str[:14]
            t = time.strptime(key_str, "%Y%m%d%H%M%S")
            date_str = time.strftime("%Y.%m.%d", t); day_of_week = t.tm_wday + 1
            day_str = f"[{day_of_week}]"; time_str = time.strftime("%H:%M", t)
            dw = self.layout_info.get('desktop_width')
            dh = self.layout_info.get('desktop_height')
            res_str = f"{dw}x{dh}" if dw and dh else "N/A"

            return f"{title}, {date_str}{day_str} {time_str}, {res_str}"
        except Exception: return "信息格式错误"

    def on_delete_clicked(self):
        self.tooltip_label.hide()
        self.delete_requested.emit(self.layout_info)

    def set_delete_highlight(self, highlight):
        self.delete_btn.setStyleSheet(self.delete_btn_style_pending if highlight else self.delete_btn_style_normal)

    def enterEvent(self, event):
        self.is_hovered = True
        self.setStyleSheet(self.hover_style)
        self.update()

    def leaveEvent(self, event):
        self.is_hovered = False
        self.setStyleSheet(self.base_style)
        self.update()

    def mousePressEvent(self, event):
        self.tooltip_label.hide()
        child = self.childAt(event.pos())
        if event.button() == Qt.LeftButton and child != self.delete_btn:
            if self.selector_window: self.selector_window.cancel_deletion_mode()
            self.clicked.emit(self.layout_info)

    def paintEvent(self, event):
        super().paintEvent(event)
        painter = QPainter(self); painter.setRenderHint(QPainter.Antialiasing)
        panel_width, panel_height = self.width(), self.height()

        preview_rect = QRect(10, 28, panel_width - 20, panel_height - 38)

        dw = self.layout_info.get('desktop_width'); dh = self.layout_info.get('desktop_height')
        if not dw or not dh:
            dw = dw or g_platform_manager.get_screen_metrics().get('width')
            dh = dh or g_platform_manager.get_screen_metrics().get('height')

        scale = min(preview_rect.width() / dw, preview_rect.height() / dh); scaled_dw, scaled_dh = int(dw * scale), int(dh * scale)
        offset_x = preview_rect.x() + (preview_rect.width() - scaled_dw) // 2; offset_y = preview_rect.y() + (preview_rect.height() - scaled_dh) // 2
        painter.setBrush(QColor(PALETTE['PREVIEW_DESKTOP'])); painter.setPen(Qt.NoPen); painter.drawRoundedRect(offset_x, offset_y, scaled_dw, scaled_dh, 2, 2)
        wx, wy = self.layout_info.get('x', 0), self.layout_info.get('y', 0); ww, wh = self.layout_info.get('width', 100), self.layout_info.get('height', 100)
        scaled_x, scaled_y = int(wx * scale) + offset_x, int(wy * scale) + offset_y; scaled_w, scaled_h = int(ww * scale), int(wh * scale)
        painter.setBrush(QColor(PALETTE['PREVIEW_WINDOW'])); painter.drawRoundedRect(scaled_x, scaled_y, scaled_w, scaled_h, 1, 1)


class LayoutSelectorWindow(QWidget):
    def __init__(self, active_hwnd_handle, layouts, window_class_name, parent=None):
        super().__init__(parent)
        self.active_hwnd_handle = active_hwnd_handle
        self.layouts = layouts
        self.window_class_name = window_class_name
        self.panels = {}
        self.pending_delete_key = None
        self.focus_timer = None
        self.content_widget = None
        self.scroll_area = None
        self.grid_layout = None
        self.main_content_layout = None
        self.is_closing = False

        self.initUI()

    def initUI(self):
        self.setFixedSize(800, 600)
        self.setWindowTitle("选择布局")
        self.setWindowOpacity(0.97)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool | Qt.NoDropShadowWindowHint)
        self.setFocusPolicy(Qt.StrongFocus)

        self.setStyleSheet(f"""
            QWidget {{ background-color: transparent; }}
            QScrollArea {{ border: none; }}
            QScrollArea > QWidget > QWidget {{ background: transparent; }}
            QScrollBar:vertical {{ border: none; background: transparent; width: 12px; margin: 0px; }}
            QScrollBar::handle:vertical {{
                background: {PALETTE['BORDER_HIGHLIGHT']}; min-height: 20px;
                border-top-left-radius: 0px; border-bottom-left-radius: 0px;
                border-top-right-radius: 4px; border-bottom-right-radius: 4px;
            }}
            QScrollBar::handle:vertical:hover {{ background: {PALETTE['DELETE_HOVER_FG']}; }}
            QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{ background: transparent; }}
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ border: none; background: none; height: 0px; }}
        """)

        self.scroll_area = QScrollArea(self)
        self.scroll_area.setWidgetResizable(True)
        self.scroll_area.setGeometry(0, 0, 800, 600)
        self.scroll_area.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.scroll_area.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded)

        self.content_widget = QWidget()
        self.scroll_area.setWidget(self.content_widget)

        self.main_content_layout = QVBoxLayout(self.content_widget)
        self.main_content_layout.setContentsMargins(0, 0, 0, 0)
        self.grid_layout = QGridLayout()
        self.grid_layout.setSpacing(10)
        self.grid_layout.setContentsMargins(10, 10, 10, 10)
        self.main_content_layout.addStretch(1)
        self.main_content_layout.addLayout(self.grid_layout)
        self.main_content_layout.addStretch(1)

        self.populate_grid()
        self.center_window()

        self.focus_timer = QTimer(self); self.focus_timer.timeout.connect(self.check_focus); self.focus_timer.start(1000)

    def populate_grid(self):
        while self.grid_layout.count():
            item = self.grid_layout.takeAt(0)
            if item.widget(): item.widget().deleteLater()
        self.panels.clear()
        row, col = 0, 0
        sorted_layouts = sorted(self.layouts, key=lambda x: x['key'], reverse=True)
        self.layouts = sorted_layouts
        for layout in self.layouts:
            panel = LayoutPreviewPanel(layout); panel.selector_window = self
            panel.clicked.connect(self.on_panel_clicked); panel.delete_requested.connect(self.on_delete_request)
            self.grid_layout.addWidget(panel, row, col); self.panels[layout['key']] = panel
            col += 1;
            if col > 1: col = 0; row += 1

    def reflow_grid(self):
        all_panels = sorted(self.panels.values(), key=lambda p: p.layout_info['key'], reverse=True)

        while self.grid_layout.count():
            item = self.grid_layout.takeAt(0)
            if item and item.widget():
                item.widget().setParent(None)

        row, col = 0, 0
        for panel in all_panels:
            if panel:
                self.grid_layout.addWidget(panel, row, col)
                col += 1
                if col > 1: col = 0; row += 1

        self.grid_layout.update()

    def add_new_layout(self, layout_info):
        print(f"实时添加新布局: {layout_info['key']}")
        panel = LayoutPreviewPanel(layout_info); panel.selector_window = self
        panel.clicked.connect(self.on_panel_clicked); panel.delete_requested.connect(self.on_delete_request)
        self.layouts.insert(0, layout_info); self.panels[layout_info['key']] = panel
        self.reflow_grid()

    def paintEvent(self, event):
        painter = QPainter(self); painter.setRenderHint(QPainter.Antialiasing)
        bg_color = QColor(PALETTE['BG_MAIN_PENDING']) if self.pending_delete_key else QColor(PALETTE['BG_MAIN'])
        painter.setBrush(bg_color);
        painter.setPen(Qt.NoPen)
        painter.drawRoundedRect(self.rect(), 4, 4)

    def check_focus(self):
        try:
            if self.is_closing:
                if self.focus_timer: self.focus_timer.stop()
                return

            # (R26) 创建后 3s 宽限期 — 给 Windows 足够时间转移焦点
            if hasattr(self, '_created_at') and time.time() - self._created_at < 3.0:
                return

            foreground_handle = g_platform_manager.get_foreground_window_handle()
            if not foreground_handle: return

            my_handle = int(self.winId())
            if foreground_handle == my_handle: return

            root_owner = g_platform_manager.get_ancestor(foreground_handle)
            if root_owner == my_handle: return

            if not self.is_closing:
                self.close()
        except Exception as e:
            if 'Internal C++ object' not in str(e): print(f"检查焦点时出错: {e}")
            if self and not self.is_closing:
                try: self.close()
                except: pass

    def center_window(self):
        qr = self.frameGeometry(); cp = QDesktopWidget().availableGeometry().center(); qr.moveCenter(cp); self.move(qr.topLeft())

    def set_deletion_mode(self, key):
        self.pending_delete_key = key
        for panel_key, panel in self.panels.items():
            panel.set_delete_highlight(panel_key == key)
        self.update()

    def cancel_deletion_mode(self):
        if self.pending_delete_key is None: return
        self.pending_delete_key = None
        for panel in self.panels.values():
            panel.set_delete_highlight(False)
        self.update()

    def on_panel_clicked(self, layout_info):
        self.cancel_deletion_mode()
        g_platform_manager.set_window_layout(self.active_hwnd_handle, layout_info)
        self.close()

    def on_delete_request(self, layout_info):
        key_to_delete = layout_info['key']
        if self.pending_delete_key == key_to_delete:
            panel_to_delete = self.panels.get(key_to_delete);
            if not panel_to_delete: return

            self.pending_delete_key = None
            panel_to_delete.set_delete_highlight(False)
            self.execute_delete(key_to_delete, panel_to_delete)

        elif self.pending_delete_key is not None:
            self.set_deletion_mode(key_to_delete)
        else:
            self.set_deletion_mode(key_to_delete)

    def execute_delete(self, key, panel):
        if self.is_closing: return

        # (R22) 修复: 现在 'config' 已被导入, 不会再 NameError
        if not config.delete_layout_from_config(key):
            show_custom_message("错误", "删除布局时出错，请检查文件权限。");
            self.cancel_deletion_mode()
            return

        scroll_value = self.scroll_area.verticalScrollBar().value()

        self.panels.pop(key, None)
        self.layouts = [l for l in self.layouts if l['key'] != key]

        panel.hide()
        self.grid_layout.removeWidget(panel)
        panel.setParent(None)

        self.reflow_grid()
        panel.deleteLater()
        self.scroll_area.verticalScrollBar().setValue(scroll_value)
        self.cancel_deletion_mode()

    def mousePressEvent(self, event):
        child = self.childAt(event.pos()); is_background = False
        if not child: is_background = True
        else:
            parent = child
            while parent:
                if isinstance(parent, QScrollArea):
                    if child == parent.viewport() or child == parent.widget(): is_background = True; break
                parent = parent.parent()
            if child == self: is_background = True
        if is_background: self.cancel_deletion_mode()
        super().mousePressEvent(event)

    def keyPressEvent(self, event: QKeyEvent):
        if event.key() == Qt.Key_W:

            window_info = g_platform_manager.get_window_info(self.active_hwnd_handle)

            if not window_info or not window_info.get('handle'):
                show_custom_message("错误", "无法获取当前窗口的信息。")
                return

            new_key = g_save_callback(window_info)

            if new_key and self.window_class_name == window_info['class_name']:
                layout_info = {
                    'key': new_key, 'title': window_info['title'], 'class_name': window_info['class_name'],
                    'x': window_info['x'], 'y': window_info['y'], 'width': window_info['width'], 'height': window_info['height'],
                    'desktop_width': window_info['desktop_width'], 'desktop_height': window_info['desktop_height']
                }
                self.add_new_layout(layout_info)
        else:
            super().keyPressEvent(event)

    def close(self):
        if self.is_closing: return
        self.is_closing = True

        if self.focus_timer:
            self.focus_timer.stop()
            self.focus_timer = None

        global layout_selector_window
        layout_selector_window = None

        super().close()

    def closeEvent(self, event):
        super().closeEvent(event)

layout_selector_window = None
