# main_r21.py (R24 更新版)
# (R24 新增): 光标下窗口=焦点窗口时跳过 3W/3X，防止误触发
# (R23 修复): 设置 setQuitOnLastWindowClosed(False) 防止自动退出
# (R22 修复): 导入 signal 和 QTimer 以修复 Ctrl+C
# (R21 修复): 使用 pyqtSignal 替换 QTimer.singleShot 来实现线程安全

import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))  # goods/ dir

import sys
import time
import threading
import signal # (R22) 导入 signal

# (R25) 单例保护: allowMultiple=false → 防多开
from _singleton import check_and_register as _check_singleton
_check_singleton('window-there')
from PyQt5.QtWidgets import QApplication
from PyQt5.QtGui import QFont
from PyQt5.QtCore import QCoreApplication, QObject, pyqtSignal, QTimer # (R22) 导入 QTimer

# (R20) 导入重构后的模块
import ge_2_env as config
import ge_2_ui as ui
import ge_2_platform as platform

# (R20) 导入新的钩子库
try:
    from pynput import keyboard
except ImportError:
    print("错误: 缺少 'pynput' 库。请运行: pip install pynput")
    sys.exit(1)


# --- (R20) 全局变量 ---
W_KEY_COUNT_CONFIRM_THRESHOLD = 3
X_KEY_COUNT_THRESHOLD = 3
SHIFT_KEY_COUNT_THRESHOLD = 3
TIME_WINDOW = 1.0

w_key_count, x_key_count, shift_key_count = 0, 0, 0
last_w_key_time, last_x_key_time, last_shift_key_time = 0, 0, 0

g_platform = None
g_qt_aqq = None
g_listener_thread = None
stop_listener_flag = threading.Event()

# --- (R21) 线程安全信号发射器 ---
class KeySignalEmitter(QObject):
    w_key_triggered = pyqtSignal()
    x_key_triggered = pyqtSignal()
    shift_key_triggered = pyqtSignal()

g_signal_emitter = None


# --- (R21) pynput 键盘钩子逻辑 ---

def on_key_release(key):
    global w_key_count, x_key_count, shift_key_count, last_w_key_time, last_x_key_time, last_shift_key_time

    try:
        vk_w = keyboard.KeyCode.from_char('w')
        vk_x = keyboard.KeyCode.from_char('x')
        current_time = time.time()

        # 检测 Shift 键 (左右 Shift 均可)
        if key in (keyboard.Key.shift, keyboard.Key.shift_l, keyboard.Key.shift_r):
            shift_key_count = 1 if current_time - last_shift_key_time > TIME_WINDOW else shift_key_count + 1
            last_shift_key_time = current_time

            if shift_key_count >= SHIFT_KEY_COUNT_THRESHOLD:
                print("R24: 检测到 3Shift")
                if g_signal_emitter:
                    g_signal_emitter.shift_key_triggered.emit()
                shift_key_count = 0

        elif key == vk_w:
            w_key_count = 1 if current_time - last_w_key_time > TIME_WINDOW else w_key_count + 1
            last_w_key_time = current_time

            if w_key_count == W_KEY_COUNT_CONFIRM_THRESHOLD:
                print("R24: 检测到 3W")
                if g_signal_emitter:
                    g_signal_emitter.w_key_triggered.emit()
                w_key_count = 0

        elif key == vk_x:
            x_key_count = 1 if current_time - last_x_key_time > TIME_WINDOW else x_key_count + 1
            last_x_key_time = current_time

            if x_key_count >= X_KEY_COUNT_THRESHOLD:
                print("R24: 检测到 3X")
                if g_signal_emitter:
                    g_signal_emitter.x_key_triggered.emit()
                x_key_count = 0

    except Exception as e:
        # 使用env中的错误处理器
        error_handler = config.env_instance.error_handler
        if error_handler:
            error_handler.log_error(e, "on_key_release")
        else:
            print(f"R24 pynput 钩子错误: {e}")

def start_key_listener():
    global g_listener_thread
    print("R24: 正在启动 pynput 键盘监听器...")

    def listener_loop():
        try:
            with keyboard.Listener(on_release=on_key_release) as listener:
                stop_listener_flag.wait()
                listener.stop()
                print("R24: pynput 监听器已停止。")
        except Exception as e:
            error_handler = config.env_instance.error_handler
            if error_handler:
                error_handler.log_error(e, "listener_loop")
            else:
                print(f"R24 pynput 监听器错误: {e}")

    g_listener_thread = threading.Thread(target=listener_loop, daemon=True)
    g_listener_thread.start()
    print("R24: pynput 监听器已在后台线程启动。")


# --- (R20) 事件处理程序 (运行在 Qt 主线程) ---

def _is_cursor_on_focus_window(window_info):
    """检查光标下窗口是否为当前焦点窗口 → 是则返回 True（避免 3W/3X 误触发）"""
    global g_platform
    fg_handle = g_platform.get_foreground_window_handle()
    if not fg_handle or not window_info:
        return False
    # 两者都走 GetAncestor(GA_ROOTOWNER) 归一化后再比较
    fg_root = g_platform.get_ancestor(fg_handle)
    if not fg_root:
        return False
    return fg_root == window_info.get('handle')


def internal_save_window_info(window_info):
    return config.save_window_info_to_config(window_info, ui.show_custom_message)


def handle_w_confirm_presses():
    global g_platform

    if ui.layout_selector_window:
        return

    window_info = g_platform.get_window_under_cursor()
    if not window_info or not window_info.get('handle'):
        ui.show_custom_message("错误", "无法获取光标下窗口的信息。")
        return

    # (R24) 光标下窗口就是焦点窗口 → 用户可能在打字，跳过
    if _is_cursor_on_focus_window(window_info):
        print("R24: 3W 跳过 — 光标下窗口即焦点窗口，视为正常输入")
        return

    print("R24: 主线程处理 3W 保存...")
    new_key = internal_save_window_info(window_info)


def handle_three_shift_presses():
    """3Shift: 对当前焦点窗口展开选单 (与光标位置无关)"""
    global g_platform

    if ui.layout_selector_window and not ui.layout_selector_window.is_closing:
        print("R24: 检测到选择器已打开，正在关闭...")
        ui.layout_selector_window.close()
        QCoreApplication.processEvents()

    print("R24: 主线程处理 3Shift 还原 (焦点窗口)...")
    fg_handle = g_platform.get_foreground_window_handle()
    if not fg_handle:
        ui.show_custom_message("错误", "无法获取当前焦点窗口的句柄。")
        return

    window_info = g_platform.get_window_info(fg_handle)
    if not window_info or not window_info.get('handle'):
        ui.show_custom_message("错误", "无法获取当前焦点窗口的信息。")
        return

    current_dw = window_info.get('desktop_width')
    current_dh = window_info.get('desktop_height')

    layouts = config.load_all_layouts_for_class(window_info['class_name'], current_dw, current_dh)

    if layouts:
        ui.layout_selector_window = ui.LayoutSelectorWindow(
            window_info['handle'],
            layouts,
            window_info['class_name']
        )
        ui.layout_selector_window.show()
        ui.layout_selector_window.activateWindow()
        ui.layout_selector_window.setFocus()
    else:
        ui.show_custom_message("未找到", f"没有找到与此类名及当前分辨率匹配的已存布局。\n\n类名: {window_info['class_name']}\n当前分辨率: {current_dw}x{current_dh}")


def handle_three_x_presses():
    global g_platform

    if ui.layout_selector_window and not ui.layout_selector_window.is_closing:
        print("R24: 检测到选择器已打开，正在关闭...")
        ui.layout_selector_window.close()
        QCoreApplication.processEvents()

    window_info = g_platform.get_window_under_cursor()
    if not window_info or not window_info.get('handle'):
        ui.show_custom_message("错误", "无法获取光标下窗口的信息。")
        return

    # (R24) 光标下窗口就是焦点窗口 → 用户可能在打字，跳过
    if _is_cursor_on_focus_window(window_info):
        print("R24: 3X 跳过 — 光标下窗口即焦点窗口，视为正常输入")
        return

    print("R24: 主线程处理 3X 还原...")
    current_dw = window_info.get('desktop_width')
    current_dh = window_info.get('desktop_height')

    layouts = config.load_all_layouts_for_class(window_info['class_name'], current_dw, current_dh)

    if layouts:
        ui.layout_selector_window = ui.LayoutSelectorWindow(
            window_info['handle'],
            layouts,
            window_info['class_name']
        )
        ui.layout_selector_window.show()
        ui.layout_selector_window.activateWindow()
        ui.layout_selector_window.setFocus()
    else:
        ui.show_custom_message("未找到", f"没有找到与此类名及当前分辨率匹配的已存布局。\n\n类名: {window_info['class_name']}\n当前分辨率: {current_dw}x{current_dh}")


# --- (R24) 主程序入口 ---
def main():
    global g_platform, g_qt_aqq, g_signal_emitter

    # 初始化env管理类
    config.env_instance.initialize(platform)
    g_platform = platform.get_platform_manager()
    config.env_instance.platform = g_platform

    ui.g_platform_manager = g_platform
    ui.g_save_callback = internal_save_window_info

    g_qt_aqq = QApplication.instance() or QApplication(sys.argv)
    config.env_instance.qt_aqq = g_qt_aqq

    # --- (R23) 核心修复 ---
    # 告诉 Qt 不要因为最后一个窗口 (例如选择器或对话框) 关闭而退出整个程序
    g_qt_aqq.setQuitOnLastWindowClosed(False)
    # --- (R23) 修复结束 ---

    font = QFont("Consolas", 11)
    font.setFamilies(["Consolas", "monospace", "LXGW WenKai GB Screen", "SF Pro", "Segoe UI", "Aptos", "Roboto", "Arial"])
    g_qt_aqq.setFont(font)
    ui.g_qt_aqq_instance = g_qt_aqq

    g_signal_emitter = KeySignalEmitter()
    config.env_instance.signal_emitter = g_signal_emitter
    g_signal_emitter.w_key_triggered.connect(handle_w_confirm_presses)
    g_signal_emitter.x_key_triggered.connect(handle_three_x_presses)
    g_signal_emitter.shift_key_triggered.connect(handle_three_shift_presses)

    if not g_platform.check_requirements(ui.show_custom_message):
        print("R24: 平台需求检查失败，程序退出。")
        config.env_instance.cleanup()
        sys.exit(1)

    if not g_platform.create_mutex(config.aqq, ui.show_custom_message):
        print("R24: 单例检查失败 (程序已运行或创建互斥锁失败)，程序退出。")
        config.env_instance.cleanup()
        sys.exit(0)

    # --- (R22) 修复 Ctrl+C 开始 ---
    signal.signal(signal.SIGINT, lambda sig, frame: QApplication.quit())
    ctrl_c_timer = QTimer()
    ctrl_c_timer.timeout.connect(lambda: None)
    ctrl_c_timer.start(500)
    # --- (R22) 修复 Ctrl+C 结束 ---

    print("程序已启动，正在监听按键事件...");
    print(f"  - (R24) 使用 pynput + pyqtSignal 监听器...")
    print(f"  - 连续按 'W' 键 {W_KEY_COUNT_CONFIRM_THRESHOLD} 次以 (提示) 保存 (光标下) 窗口布局。");
    print(f"  - 连续按 'X' 键 {X_KEY_COUNT_THRESHOLD} 次以还原 (光标下) 窗口布局。");
    print(f"  - 连续按 'Shift' 键 {SHIFT_KEY_COUNT_THRESHOLD} 次以还原 (焦点) 窗口布局。");
    print(f"  - (R24) 光标下窗口是焦点窗口时 3W/3X 自动跳过 (防止误触发)");
    print(f"  - (匹配标准：窗口类名 + 当前分辨率)");
    print("  - (秘籍：在选择器界面按 'W' 键可保存当前窗口)");
    print("  - (R24) 现在可以按 Ctrl+C 退出程序。")

    try:
        start_key_listener()

        exit_code = g_qt_aqq.exec_()
        print(f"\nR24: Qt 事件循环已退出，代码: {exit_code}")

    except KeyboardInterrupt:
        print("\n程序被用户中断 (KeyboardInterrupt)。")
    except Exception as e:
        error_handler = config.env_instance.error_handler
        if error_handler:
            error_handler.log_error(e, "main_loop")
        else:
            print(f"主循环发生意外错误: {e}")
    finally:
        print("R24: 正在执行清理...")
        # 使用env管理类的清理方法
        config.env_instance.cleanup()
        print("R24: 清理完成，程序退出。")

if __name__ == "__main__":
    main()
