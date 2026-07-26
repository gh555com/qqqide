# Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

# env.py
import os
import time
import threading
import sys
import traceback
from typing import Optional, Callable, Dict, Any, List

# 跨平台配置文件路径设置
def get_config_path():
    """获取跨平台兼容的配置文件路径，确保不在系统盘"""
    import sys

    # 获取当前系统平台，使用sys.platform避免与本地platform.py冲突
    if sys.platform == 'win32':
        system = 'Windows'
    elif sys.platform == 'darwin':
        system = 'Darwin'
    elif sys.platform.startswith('linux'):
        system = 'Linux'
    else:
        system = 'Unknown'

    if system == "Windows":
        # Windows: 固定使用E:\r\pz.ini
        config_path = "E:\\r\\pz.ini"
        config_dir = os.path.dirname(config_path)
        
        # 如果目录不存在，则使用程序所在目录的上级目录
        if not os.path.exists(config_dir):
            try:
                os.makedirs(config_dir, exist_ok=True)
            except Exception:
                # 回退到程序所在目录的上级目录
                program_dir = os.path.dirname(os.path.abspath(__file__))
                config_dir = os.path.join(program_dir, "..", "r")
                config_dir = os.path.abspath(config_dir)
                os.makedirs(config_dir, exist_ok=True)
                config_path = os.path.join(config_dir, "pz.ini")

    elif system == "Linux":
        # Linux: 固定使用/data/r/pz.ini
        config_path = "/data/r/pz.ini"
        config_dir = os.path.dirname(config_path)
        
        # 如果目录不存在，则使用程序所在目录的上级目录
        if not os.path.exists(config_dir):
            try:
                os.makedirs(config_dir, exist_ok=True)
            except Exception:
                # 回退到程序所在目录的上级目录
                program_dir = os.path.dirname(os.path.abspath(__file__))
                config_dir = os.path.join(program_dir, "..", "r")
                config_dir = os.path.abspath(config_dir)
                os.makedirs(config_dir, exist_ok=True)
                config_path = os.path.join(config_dir, "pz.ini")

    elif system == "Darwin":  # macOS
        # macOS: 优先查找非系统挂载点，如果不存在则使用/Users/r/pz.ini
        import glob

        # 查找所有挂载点
        mount_points = glob.glob("/Volumes/*")
        non_system_mounts = [m for m in mount_points if not m.endswith("/Macintosh HD") and not m.endswith("/macOS")]

        if non_system_mounts:
            # 使用第一个非系统挂载点
            config_path = os.path.join(non_system_mounts[0], "r", "pz.ini")
        else:
            # 没有非系统挂载点，使用/Users/r/pz.ini
            config_path = "/Users/r/pz.ini"
        
        config_dir = os.path.dirname(config_path)
        
        # 如果目录不存在，则使用程序所在目录的上级目录
        if not os.path.exists(config_dir):
            try:
                os.makedirs(config_dir, exist_ok=True)
            except Exception:
                # 回退到程序所在目录的上级目录
                program_dir = os.path.dirname(os.path.abspath(__file__))
                config_dir = os.path.join(program_dir, "..", "r")
                config_dir = os.path.abspath(config_dir)
                os.makedirs(config_dir, exist_ok=True)
                config_path = os.path.join(config_dir, "pz.ini")

    else:
        # 其他系统：使用程序所在目录的上级目录
        program_dir = os.path.dirname(os.path.abspath(__file__))
        config_dir = os.path.join(program_dir, "..", "r")
        config_dir = os.path.abspath(config_dir)
        os.makedirs(config_dir, exist_ok=True)
        config_path = os.path.join(config_dir, "pz.ini")

    return config_path

CONFIG_PATH = get_config_path()
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
        # 配置项
        self.config_path = CONFIG_PATH
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
                from PyQt5.QtWidgets import QApplication
                self.qt_aqq = QApplication.instance() or QApplication(sys.argv)
                self.qt_aqq_instance = self.qt_aqq

            # 初始化信号发射器
            from PyQt5.QtCore import QObject, pyqtSignal
            class KeySignalEmitter(QObject):
                w_key_triggered = pyqtSignal()
                x_key_triggered = pyqtSignal()

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
                    from PyQt5.QtCore import QCoreApplication
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
    """(R20) 保存逻辑, 依赖注入了 show_prompt_callback"""
    error_handler = ErrorHandler()
    try:
        config_dir = os.path.dirname(CONFIG_PATH)
        if not os.path.exists(config_dir):
            try:
                os.makedirs(config_dir, exist_ok=True)
            except Exception as e_create:
                error_msg = error_handler.handle_file_error(e_create, "创建目录", config_dir)
                show_prompt_callback("错误", error_msg)
                return None

        ts = f"{time.strftime('%Y%m%d%H%M%S')}{int(time.time() * 1000) % 1000:03d}"

        info_text = (f"光标下窗口:\n  标题: {window_info['title']}\n  类名: {window_info['class_name']}\n"
                     f"  位置: ({window_info['x']}, {window_info['y']}) 尺寸: {window_info['width']}x{window_info['height']}\n"
                     f"  桌面: {window_info['desktop_width']}x{window_info['desktop_height']}\n\n"
                     f"是否保存此窗口布局？ (按 'W' 键或回车确认)")

        if not show_prompt_callback("保存新布局", info_text, "yesno"):
            return None

        lines = []
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f: lines = f.readlines()

        # 查找kqs节，如果不存在则创建
        section_start = -1
        for i, line in enumerate(lines):
            if line.strip() == f"[{aqq}]": 
                section_start = i
                break
        
        # 如果没有找到kqs节，则创建一个
        if section_start == -1:
            # 移除可能存在的空行
            while lines and lines[-1].strip() == '':
                lines.pop()
            lines.append(f"\n[{aqq}]\n")
            section_start = len(lines) - 1

        new_entry = [f"{ts}q={window_info['title']}\n", f"{ts}z={window_info['class_name']}\n", f"{ts}x={window_info['x']}\n", f"{ts}y={window_info['y']}\n", f"{ts}w={window_info['width']}\n", f"{ts}h={window_info['height']}\n", f"{ts}dw={window_info['desktop_width']}\n", f"{ts}dh={window_info['desktop_height']}\n"]

        if section_start == -1:
            lines = [f"[{aqq}]\n"] + new_entry + (['\n'] if lines else []) + lines
        else:
            # 找到kqs节的结束位置
            section_end = len(lines)
            for i in range(section_start + 1, len(lines)):
                if lines[i].strip().startswith('[') and lines[i].strip() != f"[{aqq}]":
                    section_end = i
                    break
            
            # 在kqs节内插入新条目
            lines[section_end:section_end] = new_entry

        with open(CONFIG_PATH, 'w', encoding='utf-8') as f: f.writelines(lines)
        return ts

    except Exception as e:
        error_handler.log_error(e, "save_window_info_to_config")
        error_msg = error_handler.handle_config_error(e, "保存")
        show_prompt_callback("错误", error_msg)
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
    """(R20) 加载逻辑 (R5 逻辑不变)"""
    error_handler = ErrorHandler()
    layouts = []
    try:
        if not os.path.exists(CONFIG_PATH): return []

        with open(CONFIG_PATH, 'r', encoding='utf-8') as f: lines = f.readlines()

        # 查找kqs节
        section_start, section_end = -1, -1
        for i, line in enumerate(lines):
            if line.strip() == f"[{aqq}]": 
                section_start = i
            elif section_start != -1 and line.strip().startswith('['): 
                section_end = i
                break
        
        # 如果找到了开始但没有找到结束，则结束位置为文件末尾
        if section_start != -1 and section_end == -1: 
            section_end = len(lines)
        
        # 如果没有找到kqs节，则返回空列表
        if section_start == -1: 
            return []

        # 在kqs节内查找匹配的窗口类名
        matching_keys_lines = {}
        for i in range(section_start + 1, section_end):
            line = lines[i].strip()
            if '=' not in line: continue
            try: key, value = map(str.strip, line.split('=', 1))
            except ValueError: continue
            if key.endswith('z') and value == window_class_name: matching_keys_lines[key[:-1]] = line

        # 收集kqs节内的所有配置项
        all_lines_dict = {}
        for i in range(section_start + 1, section_end):
            line = lines[i].strip()
            if '=' not in line: continue
            try: key, value = map(str.strip, line.split('=', 1)); all_lines_dict[key] = value
            except ValueError: continue

        # 为每个匹配的时间戳构建布局信息
        for ts in matching_keys_lines.keys():
            layout_info = {'key': ts}
            try:
                layout_info['title'] = all_lines_dict.get(f"{ts}q", "")
                layout_info['x'] = _safe_int(all_lines_dict.get(f"{ts}x"), 0)
                layout_info['y'] = _safe_int(all_lines_dict.get(f"{ts}y"), 0)
                layout_info['width'] = _safe_int(all_lines_dict.get(f"{ts}w"), 100)
                layout_info['height'] = _safe_int(all_lines_dict.get(f"{ts}h"), 100)
                dw_val = all_lines_dict.get(f"{ts}dw")
                dh_val = all_lines_dict.get(f"{ts}dh")
                layout_info['desktop_width'] = _safe_int(dw_val, None)
                layout_info['desktop_height'] = _safe_int(dh_val, None)
                ldw, ldh = layout_info['desktop_width'], layout_info['desktop_height']

                # 跳过没有桌面分辨率的条目
                if ldw is None or ldh is None: continue
                
                # 跳过桌面分辨率不匹配的条目
                if ldw != current_dw or ldh != current_dh: continue

                layouts.append(layout_info)
            except (ValueError, TypeError) as e:
                error_handler.log_error(e, f"load_layouts_for_class (key: {ts})")
                continue

        # 按时间戳倒序排序（最新的在前）
        layouts.sort(key=lambda item: item['key'], reverse=True)
        return layouts

    except Exception as e:
        error_handler.log_error(e, "load_all_layouts_for_class")
        return []

def delete_layout_from_config(key_to_delete):
    """(R20) 删除逻辑 (不变)"""
    error_handler = ErrorHandler()
    try:
        if not os.path.exists(CONFIG_PATH): return False
        
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f: 
            lines = f.readlines()

        # 查找kqs节
        section_start, section_end = -1, -1
        for i, line in enumerate(lines):
            if line.strip() == f"[{aqq}]": 
                section_start = i
            elif section_start != -1 and line.strip().startswith('['): 
                section_end = i
                break
        
        # 如果找到了开始但没有找到结束，则结束位置为文件末尾
        if section_start != -1 and section_end == -1: 
            section_end = len(lines)
        
        # 如果没有找到kqs节，则返回False
        if section_start == -1: 
            return False

        # 在kqs节内删除匹配的条目
        new_lines = lines[:section_start + 1]  # 保留节开始之前的内容和节标题
        deleted_count = 0
        
        for i in range(section_start + 1, section_end):
            line = lines[i]
            # 如果不是要删除的条目，则保留
            if not line.strip().startswith(key_to_delete):
                new_lines.append(line)
            else:
                deleted_count += 1
        
        # 添加节之后的内容
        new_lines.extend(lines[section_end:])

        if deleted_count > 0:
            with open(CONFIG_PATH, 'w', encoding='utf-8') as f: 
                f.writelines(new_lines)
            return True

        return False

    except Exception as e:
        error_handler.log_error(e, "delete_layout_from_config")
        return False

