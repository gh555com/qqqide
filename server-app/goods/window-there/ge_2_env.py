# env.py
import os
import time
import threading
import sys
import traceback
from typing import Optional, Callable, Dict, Any, List

# OS-level SQLite - same DB across all IDE instances and green packs
import window_there_store

aqq = "kqs"

# === 错误处理模块 ===
class ErrorHandler:
    """集中处理各种错误情况的模块"""

    @staticmethod
    def handle_file_error(error: Exception, operation: str, file_path: str = None) -> str:
        """处理文件操作错误"""
        error_msg = f"文件{operation}时发生错误"
        if file_path:
            error_msg += f": {file_path}"
        error_msg += f"\n错误详情: {str(error)}"
        return error_msg

    @staticmethod
    def handle_config_error(error: Exception, operation: str) -> str:
        """处理配置相关错误"""
        return f"配置{operation}时发生错误:\n{str(error)}"

    @staticmethod
    def handle_platform_error(error: Exception, operation: str) -> str:
        """处理平台相关错误"""
        return f"平台{operation}时发生错误:\n{str(error)}"

    @staticmethod
    def handle_ui_error(error: Exception, operation: str) -> str:
        """处理UI相关错误"""
        return f"UI{operation}时发生错误:\n{str(error)}"

    @staticmethod
    def handle_thread_error(error: Exception, operation: str) -> str:
        """处理线程相关错误"""
        return f"线程{operation}时发生错误:\n{str(error)}"

    @staticmethod
    def log_error(error: Exception, context: str = ""):
        """记录错误到控制台"""
        if context:
            print(f"错误 [{context}]: {str(error)}")
        else:
            print(f"错误: {str(error)}")
        traceback.print_exc()


# === 环境管理类 ===
class env:
    """管理全局配置和状态的环境类"""

    def __init__(self):
        self.config_path = window_there_store._get_db_path()
        self.identifier = aqq
        self.w_key_threshold = 3
        self.x_key_threshold = 3
        self.time_window = 1.0

        # 状态变量
        self.w_key_count = 0
        self.x_key_count = 0
        self.last_w_key_time = 0
        self.last_x_key_time = 0

        # 系统组件
        self.platform = None
        self.qt_aqq = None
        self.signal_emitter = None
        self.listener_thread = None

        # UI组件
        self.save_callback = None
        self.layout_selector_window = None
        self.platform_manager = None
        self.qt_aqq_instance = None

        # 控制标志
        self.stop_listener_flag = threading.Event()

        # 错误处理器
        self.error_handler = ErrorHandler()

    def initialize(self, platform_module, qt_aqq=None):
        """初始化所有组件"""
        try:
            # 初始化平台管理器
            self.platform = platform_module.get_platform_manager()
            self.platform_manager = self.platform

            # 初始化Qt应用
            if qt_aqq:
                self.qt_aqq = qt_aqq
                self.qt_aqq_instance = qt_aqq
            else:
                from PySide2.QtWidgets import QApplication
                self.qt_aqq = QApplication.instance() or QApplication(sys.argv)
                self.qt_aqq_instance = self.qt_aqq

            # 初始化信号发射器
            from PySide2.QtCore import QObject, Signal
            class KeySignalEmitter(QObject):
                w_key_triggered = Signal()
                x_key_triggered = Signal()

            self.signal_emitter = KeySignalEmitter()

            # 设置保存回调
            self.save_callback = self._internal_save_window_info

            return True
        except Exception as e:
            self.error_handler.log_error(e, "env.initialize")
            return False

    def cleanup(self):
        """清理所有资源"""
        try:
            print("env: 正在执行清理...")

            # 1. 停止监听线程
            if self.listener_thread and self.listener_thread.is_alive():
                print("env: 停止监听线程...")
                self.stop_listener_flag.set()
                self.listener_thread.join(timeout=2.0)
                if self.listener_thread.is_alive():
                    print("env: 警告 - 监听线程未能在超时时间内停止")

            # 2. 释放平台资源
            if self.platform:
                print("env: 释放平台资源...")
                try:
                    self.platform.release_mutex()
                except Exception as e:
                    self.error_handler.log_error(e, "platform.release_mutex")

            # 3. 关闭UI窗口
            if self.layout_selector_window:
                print("env: 关闭选择器窗口...")
                try:
                    if hasattr(self.layout_selector_window, 'is_closing') and not self.layout_selector_window.is_closing:
                        self.layout_selector_window.close()
                    elif not hasattr(self.layout_selector_window, 'is_closing'):
                        self.layout_selector_window.close()
                except Exception as e:
                    self.error_handler.log_error(e, "layout_selector_window.close")

            # 4. 处理Qt应用退出
            if self.qt_aqq:
                print("env: 处理Qt应用退出...")
                try:
                    from PySide2.QtCore import QCoreApplication
                    QCoreApplication.processEvents()
                except Exception as e:
                    self.error_handler.log_error(e, "QCoreApplication.processEvents")

            print("env: 清理完成")
            return True
        except Exception as e:
            self.error_handler.log_error(e, "env.cleanup")
            return False

    def _internal_save_window_info(self, window_info):
        """内部保存回调"""
        return save_window_info_to_config(window_info, self._show_message)

    def _show_message(self, title, message, buttons="ok"):
        """显示消息的默认实现"""
        if hasattr(self, 'qt_aqq_instance') and self.qt_aqq_instance:
            try:
                # 尝试导入UI模块并使用其消息框
                import ui as ui
                return ui.show_custom_message(title, message, buttons)
            except ImportError:
                # 如果UI模块不可用，使用控制台输出
                print(f"{title}: {message}")
                return buttons != "yesno" or True
        else:
            print(f"{title}: {message}")
            return buttons != "yesno" or True


# 全局环境实例
env_instance = env()

def save_window_info_to_config(window_info, show_prompt_callback):
    """Save via SQLite (OS-level, shared across all instances)."""
    error_handler = ErrorHandler()
    try:
        info_text = (f"\u5149\u6807\u4e0b\u7a97\u53e3:\n  \u6807\u9898: {window_info['title']}\n  \u7c7b\u540d: {window_info['class_name']}\n"
                     f"  \u4f4d\u7f6e: ({window_info['x']}, {window_info['y']}) \u5c3a\u5bf8: {window_info['width']}x{window_info['height']}\n"
                     f"  \u684c\u9762: {window_info['desktop_width']}x{window_info['desktop_height']}\n\n"
                     f"\u662f\u5426\u4fdd\u5b58\u6b64\u7a97\u53e3\u5e03\u5c40\uff1f (\u6309 'W' \u952e\u6216\u56de\u8f66\u786e\u8ba4)")

        if not show_prompt_callback("\u4fdd\u5b58\u65b0\u5e03\u5c40", info_text, "yesno"):
            return None

        return window_there_store.save_layout(window_info)

    except Exception as e:
        error_handler.log_error(e, "save_window_info_to_config")
        error_msg = error_handler.handle_config_error(e, "\u4fdd\u5b58")
        show_prompt_callback("\u9519\u8bef", error_msg)
        return None


def _safe_int(val, default=0):
    """安全转int，含非数字字符时提取数字部分"""
    if val is None:
        return default
    try:
        return int(val)
    except (ValueError, TypeError):
        import re
        digits = re.sub(r'[^\d-]', '', str(val))
        return int(digits) if digits else default


def load_all_layouts_for_class(window_class_name, current_dw, current_dh):
    """Load layouts via SQLite (OS-level)."""
    error_handler = ErrorHandler()
    try:
        return window_there_store.load_layouts(window_class_name, current_dw, current_dh)
    except Exception as e:
        error_handler.log_error(e, "load_all_layouts_for_class")
        return []


def delete_layout_from_config(key_to_delete):
    """Delete layout via SQLite (OS-level)."""
    error_handler = ErrorHandler()
    try:
        return window_there_store.delete_layout(key_to_delete)
    except Exception as e:
        error_handler.log_error(e, "delete_layout_from_config")
        return False

