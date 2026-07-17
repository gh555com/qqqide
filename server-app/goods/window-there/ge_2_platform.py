# platform.py
import sys
import os

# --- 平台抽象基类 ---
class BasePlatformManager:
    """
    (R20) 平台抽象基类 (接口)
    定义了所有平台都必须实现的通用功能。
    """
    def __init__(self):
        self.mutex_handle = None
        print(f"R20: 已加载平台管理器: {self.get_platform_name()}")

    def get_platform_name(self):
        return "Base (Unsupported)"

    def check_requirements(self, show_message_callback):
        """
        检查平台特定需求 (如 Wayland 警告, macOS 权限)
        """
        show_message_callback("错误", f"当前平台 ({sys.platform}) 尚不支持。")
        return False # 默认失败

    def create_mutex(self, aqq_id, show_message_callback):
        """
        实现单例运行。
        """
        print("R20: 警告: 未实现平台特定的单例模式。")
        return True # 默认允许运行

    def release_mutex(self):
        """
        释放互斥锁。
        """
        pass

    def get_window_under_cursor(self):
        """
        (R20) 核心: 获取光标下的窗口信息
        返回一个包含 'handle', 'title', 'class_name', 'x', 'y', 'width', 'height', 'desktop_width', 'desktop_height' 的字典
        """
        print("R20: 错误: 未实现 get_window_under_cursor")
        return None

    def get_window_info(self, handle):
        """
        (R20) 核心: 通过句柄获取窗口信息 (用于 'W' 秘籍)
        """
        print("R20: 错误: 未实现 get_window_info")
        return None

    def set_window_layout(self, handle, layout_info):
        """
        (R20) 核心: 应用窗口布局
        """
        print("R20: 错误: 未实现 set_window_layout")

    def get_screen_metrics(self):
        """
        (R20) 获取屏幕分辨率 (用于 UI 预览)
        """
        print("R20: 错误: 未实现 get_screen_metrics")
        return {'width': 1920, 'height': 1080} # 默认值

    def get_foreground_window_handle(self):
        """
        (R20) 获取当前焦点窗口句柄 (用于选择器失焦检测)
        """
        print("R20: 错误: 未实现 get_foreground_window_handle")
        return None

    def get_ancestor(self, handle):
        """
        (R20) 获取顶层父窗口 (用于选择器失焦检测)
        """
        print("R20: 错误: 未实现 get_ancestor")
        return handle

# --- Windows 平台实现 (R19 逻辑) ---
if sys.platform == 'win32':
    import ctypes
    import ctypes.wintypes

    class POINT(ctypes.Structure): _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32

    # (R20) 常量移至 Windows 实现内部
    SWP_NOZORDER, SWP_NOACTIVATE = 0x0004, 0x0010
    SM_CXSCREEN, SM_CYSCREEN = 0, 1
    GA_ROOTOWNER = 3
    ERROR_ALREADY_EXISTS = 183
    NULL = 0
    MB_OK = 0x00000000
    MB_ICONINFORMATION = 0x00000040

    # (R20) API 定义移至 Windows 实现内部
    user32.GetWindowTextLengthW.argtypes = [ctypes.wintypes.HWND]
    user32.GetWindowTextW.argtypes = [ctypes.wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int]
    user32.GetClassNameW.argtypes = [ctypes.wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int]
    user32.GetWindowRect.argtypes = [ctypes.wintypes.HWND, ctypes.POINTER(ctypes.wintypes.RECT)]
    user32.SetWindowPos.argtypes = [ctypes.wintypes.HWND, ctypes.wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint]
    user32.GetSystemMetrics.argtypes = [ctypes.c_int]
    user32.GetCursorPos.argtypes = [ctypes.POINTER(POINT)]
    user32.WindowFromPoint.argtypes = [POINT]
    user32.GetAncestor.argtypes = [ctypes.wintypes.HWND, ctypes.c_uint]
    user32.GetForegroundWindow.restype = ctypes.wintypes.HWND
    user32.GetForegroundWindow.argtypes = []
    user32.MessageBoxW.argtypes = [ctypes.wintypes.HWND, ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.wintypes.UINT]
    user32.MessageBoxW.restype = ctypes.c_int
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.wintypes.BOOL, ctypes.c_wchar_p]
    kernel32.CreateMutexW.restype = ctypes.wintypes.HANDLE
    kernel32.GetLastError.argtypes = []
    kernel32.GetLastError.restype = ctypes.wintypes.DWORD
    kernel32.CloseHandle.argtypes = [ctypes.wintypes.HANDLE]
    kernel32.CloseHandle.restype = ctypes.wintypes.BOOL

    class WindowsPlatformManager(BasePlatformManager):

        def get_platform_name(self):
            return "Windows (win32)"

        def check_requirements(self, show_message_callback):
            # Windows 平台无需额外检查
            return True

        def create_mutex(self, aqq_id, show_message_callback):
            mutex_name = f"Global\\{aqq_id}_KQS_WinLayout_Mutex_v2"
            self.mutex_handle = kernel32.CreateMutexW(NULL, True, mutex_name)
            last_error = kernel32.GetLastError()

            if not self.mutex_handle:
                show_message_callback("kqs 窗口布局 - 启动错误", f"创建互斥锁失败，无法启动。\n错误码: {last_error}", "ok")
                return False

            if last_error == ERROR_ALREADY_EXISTS:
                show_message_callback("kqs 窗口布局", "程序已在运行。", "ok")
                self.release_mutex() # 释放刚创建的多余句柄
                return False

            print("R20: 程序单例检查通过 (Windows)。")
            return True

        def release_mutex(self):
            if self.mutex_handle:
                kernel32.CloseHandle(self.mutex_handle)
                self.mutex_handle = None
                print("R20: 互斥锁已释放 (Windows)。")

        def _get_window_info(self, hwnd):
            """(R20) 内部辅助函数"""
            try:
                if not hwnd: return None
                hwnd_root = hwnd
                title_len = user32.GetWindowTextLengthW(hwnd_root) + 1; title_buf = ctypes.create_unicode_buffer(title_len)
                user32.GetWindowTextW(hwnd_root, title_buf, title_len); class_name_buf = ctypes.create_unicode_buffer(256)
                user32.GetClassNameW(hwnd_root, class_name_buf, 256); rect = ctypes.wintypes.RECT()
                user32.GetWindowRect(hwnd_root, ctypes.byref(rect));
                desktop_width = user32.GetSystemMetrics(SM_CXSCREEN)
                desktop_height = user32.GetSystemMetrics(SM_CYSCREEN)
                return {
                    'handle': hwnd_root,
                    'title': title_buf.value,
                    'class_name': class_name_buf.value,
                    'x': rect.left, 'y': rect.top,
                    'width': rect.right - rect.left,
                    'height': rect.bottom - rect.top,
                    'desktop_width': desktop_width,
                    'desktop_height': desktop_height
                }
            except Exception as e:
                print(f"获取 HWND {hwnd} 窗口信息时出错: {e}")
                return None

        def _handle_accessibility_error(self, operation_name, error=None):
            """
            处理因权限不足导致的操作失败
            返回: None (用于替代返回值)
            """
            error_msg = f"操作'{operation_name}'失败，可能是因为缺少辅助功能权限。"

            if not self.accessibility_checked:
                error_msg += "\n\n权限尚未检查，请重启程序。"
            elif not self.accessibility_granted:
                error_msg += f"\n\n{self._get_accessibility_instructions()}"

            if error:
                error_msg += f"\n\n错误详情: {str(error)}"

            print(error_msg)
            return None

        def get_window_under_cursor(self):
            """(R20) Windows 实现 (抓光标下)"""
            try:
                pt = POINT(); user32.GetCursorPos(ctypes.byref(pt)); hwnd = user32.WindowFromPoint(pt);
                if not hwnd: return None
                hwnd_root = user32.GetAncestor(hwnd, GA_ROOTOWNER);
                if not hwnd_root: hwnd_root = hwnd
                return self._get_window_info(hwnd_root)
            except Exception as e:
                print(f"获取光标窗口信息时出错: {e}")
                return None

        def get_window_info(self, handle):
            """(R20) Windows 实现 (抓指定句柄)"""
            return self._get_window_info(handle)

        def set_window_layout(self, handle, layout_info):
            """(R20) Windows 实现"""
            try:
                flags = SWP_NOZORDER | SWP_NOACTIVATE
                x, y, w, h = layout_info['x'], layout_info['y'], layout_info['width'], layout_info['height']
                if not user32.SetWindowPos(handle, None, x, y, w, h, flags):
                    print(f"应用窗口布局失败 (HWND: {handle})。WinAPI错误")
                else:
                    print(f"窗口布局已还原 (HWND: {handle})")
            except Exception as e:
                print(f"设置窗口位置时出错: {e}")

        def get_screen_metrics(self):
            """(R20) Windows 实现"""
            return {
                'width': user32.GetSystemMetrics(SM_CXSCREEN),
                'height': user32.GetSystemMetrics(SM_CYSCREEN)
            }

        def get_foreground_window_handle(self):
            """(R20) Windows 实现"""
            try: return user32.GetForegroundWindow()
            except: return None

        def get_ancestor(self, handle):
            """(R20) Windows 实现"""
            try: return user32.GetAncestor(handle, GA_ROOTOWNER)
            except: return handle


# --- Linux 平台实现 (R20 占位符) ---
elif sys.platform == 'linux':

    class LinuxPlatformManager(BasePlatformManager):

        def __init__(self):
            self.display_server = self._detect_display_server()
            print(f"检测到显示服务器类型: {self.display_server}")

        def _detect_display_server(self):
            """
            检测Linux系统使用的显示服务器类型 (X11 或 Wayland)
            """
            import os

            # 方法1: 检查WAYLAND_DISPLAY环境变量
            if os.environ.get('WAYLAND_DISPLAY'):
                return "Wayland"

            # 方法2: 检查XDG_SESSION_TYPE环境变量
            session_type = os.environ.get('XDG_SESSION_TYPE', '').lower()
            if session_type == 'wayland':
                return "Wayland"
            elif session_type == 'x11':
                return "X11"

            # 方法3: 检查DISPLAY环境变量 (X11)
            if os.environ.get('DISPLAY'):
                return "X11"

            # 方法4: 尝试通过ps命令检查当前会话
            try:
                import subprocess
                result = subprocess.run(['ps', '-e'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                if result.returncode == 0:
                    processes = result.stdout.lower()
                    if 'wayland' in processes:
                        return "Wayland"
                    elif 'xorg' in processes or 'x11' in processes:
                        return "X11"
            except Exception:
                pass

            # 方法5: 尝试检查登录管理器配置
            try:
                import subprocess
                # 检查当前桌面环境
                desktop = os.environ.get('XDG_CURRENT_DESKTOP', '').lower()
                if desktop in ('gnome', 'ubuntu'):
                    # GNOME默认使用Wayland，但可能在X11下运行
                    try:
                        result = subprocess.run(['echo', '$XDG_SESSION_TYPE'], shell=True,
                                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                        if 'wayland' in result.stdout.lower():
                            return "Wayland"
                    except Exception:
                        pass
            except Exception:
                pass

            # 默认假设为X11
            return "X11"

        def get_platform_name(self):
            return f"Linux ({self.display_server})"

        def check_requirements(self, show_message_callback):
            """
            (R24) 检测Linux依赖和显示服务器
            """
            # 检查显示服务器类型
            if self.display_server == "Wayland":
                # 尝试检测是否支持XWayland
                if self._check_xwayland_support():
                    show_message_callback(
                        "kqs 窗口布局 - 有限支持",
                        "检测到 Wayland 显示服务器，但检测到 XWayland 支持。\n\n"
                        "程序将以有限模式运行，仅支持 XWayland 应用程序。\n\n"
                        "对于原生 Wayland 应用程序，窗口管理功能可能不可用。",
                        "ok"
                    )
                    self.wayland_mode = "XWayland"
                    return True
                else:
                    show_message_callback(
                        "kqs 窗口布局 - 不兼容",
                        "检测到 Wayland 显示服务器，且未检测到 XWayland 支持。\n\n"
                        "Wayland 的安全策略禁止本程序抓取其他窗口信息和监听全局按键。\n\n"
                        "请尝试在登录界面切换到 X11 (X.Org) 会话以使用本程序。\n\n"
                        "或者，您可以尝试安装 XWayland 以获得有限支持。",
                        "ok"
                    )
                    self.wayland_mode = "Unsupported"
                    return False
            else:
                self.wayland_mode = "X11"

            # 检查 python-xlib 是否安装
            try:
                import Xlib
                print(f"检测到 {self.display_server} 会话, Xlib 已安装。")
            except ImportError:
                show_message_callback(
                    "kqs 窗口布局 - 缺少依赖",
                    f"在 Linux ({self.display_server}) 平台运行需要 `python-xlib` 库。\n\n"
                    "请运行: pip install python-xlib",
                    "ok"
                )
                return False

            print(f"检测到 {self.display_server} 会话, 检查通过。")
            return True

        def _check_xwayland_support(self):
            """
            检查是否支持XWayland
            """
            import os
            import subprocess

            # 方法1: 检查XWayland进程
            try:
                result = subprocess.run(['ps', '-e'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                if result.returncode == 0 and 'Xwayland' in result.stdout:
                    return True
            except Exception:
                pass

            # 方法2: 检查WAYLAND_DISPLAY和DISPLAY环境变量
            if os.environ.get('WAYLAND_DISPLAY') and os.environ.get('DISPLAY'):
                return True

            # 方法3: 尝试连接到X11显示
            try:
                import Xlib.display
                display = Xlib.display.Display()
                display.close()
                return True
            except Exception:
                pass

            return False

        def create_mutex(self, aqq_id, show_message_callback):
            """
            (R24) Linux 单例实现，使用文件锁
            """
            import fcntl
            import os
            import tempfile

            # 在临时目录创建锁文件
            lock_dir = tempfile.gettempdir()
            lock_file_path = os.path.join(lock_dir, f".{aqq_id}_KQS_WinLayout_Mutex_v2.lock")

            try:
                # 创建并打开锁文件
                self.lock_file = open(lock_file_path, 'w')

                # 尝试获取排他锁
                fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)

                # 写入当前进程ID
                self.lock_file.write(str(os.getpid()))
                self.lock_file.flush()

                # 保存aqq_id用于后续释放锁
                self.aqq_id = aqq_id

                print("R24: 程序单例检查通过 (Linux)。")
                return True

            except (IOError, OSError):
                # 获取锁失败，说明程序已在运行
                if hasattr(self, 'lock_file') and self.lock_file:
                    self.lock_file.close()
                    self.lock_file = None

                show_message_callback("kqs 窗口布局", "程序已在运行。", "ok")
                return False

        def release_mutex(self):
            """
            (R24) 释放Linux文件锁
            """
            if hasattr(self, 'lock_file') and self.lock_file:
                try:
                    # 释放文件锁
                    fcntl.flock(self.lock_file, fcntl.LOCK_UN)
                    self.lock_file.close()

                    # 删除锁文件
                    import tempfile
                    import os
                    lock_dir = tempfile.gettempdir()
                    if hasattr(self, 'aqq_id'):
                        lock_file_path = os.path.join(lock_dir, f".{self.aqq_id}_KQS_WinLayout_Mutex_v2.lock")
                        if os.path.exists(lock_file_path):
                            os.remove(lock_file_path)

                    self.lock_file = None
                    print("R24: 互斥锁已释放 (Linux)。")
                except Exception as e:
                    print(f"R24: 释放互斥锁时出错: {e}")

        def get_window_under_cursor(self):
            """
            (R24) Linux实现：获取光标下的窗口信息
            """
            # 在纯Wayland环境下无法实现
            if hasattr(self, 'wayland_mode') and self.wayland_mode == "Unsupported":
                print("错误: 纯Wayland环境下无法获取窗口信息")
                return None

            # 在XWayland环境下尝试使用X11 API
            try:
                import Xlib.display
                from Xlib.ext import randr
                from Xlib import X

                # 连接到X11显示
                display = Xlib.display.Display()
                screen = display.screen()
                root = screen.root

                # 获取鼠标位置
                root_query = root.query_pointer()
                mouse_x, mouse_y = root_query.root_x, root_query.root_y

                # 获取鼠标位置的窗口
                window = root_query.child

                if not window:
                    return None

                # 获取窗口的几何信息
                geom = window.get_geometry()
                x, y, width, height = geom.x, geom.y, geom.width, geom.height

                # 获取窗口属性
                window_class = window.get_wm_class()
                window_name = window.get_wm_name()

                # 获取窗口ID
                window_id = window.id

                # 获取屏幕分辨率
                screen_width = screen.width_in_pixels
                screen_height = screen.height_in_pixels

                # 获取窗口在屏幕上的绝对位置
                tree = window.query_tree()
                parent = tree.parent

                # 计算窗口的绝对位置
                abs_x, abs_y = x, y
                while parent and parent.id != root.id:
                    parent_geom = parent.get_geometry()
                    abs_x += parent_geom.x
                    abs_y += parent_geom.y
                    tree = parent.query_tree()
                    parent = tree.parent

                return {
                    'handle': window_id,
                    'title': window_name or "",
                    'class_name': window_class[0] if window_class and len(window_class) > 0 else "",
                    'x': abs_x,
                    'y': abs_y,
                    'width': width,
                    'height': height,
                    'desktop_width': screen_width,
                    'desktop_height': screen_height
                }

            except ImportError:
                print("错误: 需要安装 python-xlib 库")
                return None
            except Exception as e:
                if hasattr(self, 'wayland_mode') and self.wayland_mode == "XWayland":
                    print(f"在XWayland环境下获取窗口信息失败 (可能不是XWayland应用): {e}")
                else:
                    print(f"获取光标下窗口信息时出错: {e}")
                return None

        def get_window_info(self, handle):
            """
            (R24) Linux实现：获取指定句柄的窗口信息
            """
            # 在纯Wayland环境下无法实现
            if hasattr(self, 'wayland_mode') and self.wayland_mode == "Unsupported":
                print("错误: 纯Wayland环境下无法获取窗口信息")
                return None

            # 在XWayland环境下尝试使用X11 API
            try:
                import Xlib.display

                # 连接到X11显示
                display = Xlib.display.Display()
                screen = display.screen()
                root = screen.root

                # 通过句柄获取窗口对象
                window = display.create_resource_object('window', handle)

                # 获取窗口的几何信息
                geom = window.get_geometry()
                x, y, width, height = geom.x, geom.y, geom.width, geom.height

                # 获取窗口属性
                window_class = window.get_wm_class()
                window_name = window.get_wm_name()

                # 获取屏幕分辨率
                screen_width = screen.width_in_pixels
                screen_height = screen.height_in_pixels

                # 获取窗口在屏幕上的绝对位置
                tree = window.query_tree()
                parent = tree.parent

                # 计算窗口的绝对位置
                abs_x, abs_y = x, y
                while parent and parent.id != root.id:
                    parent_geom = parent.get_geometry()
                    abs_x += parent_geom.x
                    abs_y += parent_geom.y
                    tree = parent.query_tree()
                    parent = tree.parent

                return {
                    'handle': handle,
                    'title': window_name or "",
                    'class_name': window_class[0] if window_class and len(window_class) > 0 else "",
                    'x': abs_x,
                    'y': abs_y,
                    'width': width,
                    'height': height,
                    'desktop_width': screen_width,
                    'desktop_height': screen_height
                }

            except ImportError:
                print("错误: 需要安装 python-xlib 库")
                return None
            except Exception as e:
                if hasattr(self, 'wayland_mode') and self.wayland_mode == "XWayland":
                    print(f"在XWayland环境下获取窗口信息失败 (可能不是XWayland应用): {e}")
                else:
                    print(f"获取窗口信息时出错: {e}")
                return None

        def set_window_layout(self, handle, layout_info):
            """
            (R24) Linux实现：设置窗口布局
            """
            # 在纯Wayland环境下无法实现
            if hasattr(self, 'wayland_mode') and self.wayland_mode == "Unsupported":
                print("错误: 纯Wayland环境下无法设置窗口布局")
                return False

            # 在XWayland环境下尝试使用X11 API
            try:
                import Xlib.display
                from Xlib import X

                # 连接到X11显示
                display = Xlib.display.Display()

                # 通过句柄获取窗口对象
                window = display.create_resource_object('window', handle)

                # 获取布局信息
                x, y, width, height = layout_info['x'], layout_info['y'], layout_info['width'], layout_info['height']

                # 配置窗口
                window.configure(x=x, y=y, width=width, height=height, border_width=0)

                # 刷新显示
                display.sync()

                print(f"窗口布局已设置 (handle: {handle})")
                return True

            except ImportError:
                print("错误: 需要安装 python-xlib 库")
                return False
            except Exception as e:
                if hasattr(self, 'wayland_mode') and self.wayland_mode == "XWayland":
                    print(f"在XWayland环境下设置窗口布局失败 (可能不是XWayland应用): {e}")
                else:
                    print(f"设置窗口布局时出错: {e}")
                return False

        def get_screen_metrics(self):
            """
            (R24) Linux实现：获取屏幕分辨率
            """
            try:
                import Xlib.display

                # 连接到X11显示
                display = Xlib.display.Display()
                screen = display.screen()

                return {
                    'width': screen.width_in_pixels,
                    'height': screen.height_in_pixels
                }

            except ImportError:
                print("错误: 需要安装 python-xlib 库")
                return {'width': 0, 'height': 0}
            except Exception as e:
                print(f"获取屏幕分辨率时出错: {e}")
                return {'width': 0, 'height': 0}

        def get_foreground_window_handle(self):
            """
            (R24) Linux实现：获取当前活动窗口的句柄
            """
            try:
                import Xlib.display

                # 连接到X11显示
                display = Xlib.display.Display()
                screen = display.screen()
                root = screen.root

                # 获取输入焦点窗口
                focused_window = display.get_input_focus().focus

                if focused_window == X.NONE:
                    return None

                return focused_window.id

            except ImportError:
                print("错误: 需要安装 python-xlib 库")
                return None
            except Exception as e:
                print(f"获取当前活动窗口时出错: {e}")
                return None

        def get_ancestor(self, handle):
            """
            (R24) Linux实现：获取窗口的根父窗口
            """
            try:
                import Xlib.display

                # 连接到X11显示
                display = Xlib.display.Display()
                screen = display.screen()
                root = screen.root

                # 通过句柄获取窗口对象
                window = display.create_resource_object('window', handle)

                # 获取窗口树
                tree = window.query_tree()
                parent = tree.parent

                # 如果父窗口是根窗口，则返回当前窗口
                if parent.id == root.id:
                    return handle

                # 递归查找根父窗口
                while parent and parent.id != root.id:
                    tree = parent.query_tree()
                    grandparent = tree.parent

                    if grandparent.id == root.id:
                        return parent.id

                    parent = grandparent

                return handle

            except ImportError:
                print("错误: 需要安装 python-xlib 库")
                return handle
            except Exception as e:
                print(f"获取窗口根父窗口时出错: {e}")
                return handle


# --- macOS 平台实现 (R20 占位符) ---
elif sys.platform == 'darwin':

    class MacOSPlatformManager(BasePlatformManager):

        def __init__(self):
            """
            初始化MacOSPlatformManager
            """
            self.accessibility_checked = False
            self.accessibility_granted = False

        def get_platform_name(self):
            return "macOS (darwin)"

        def _check_accessibility_permission(self):
            """
            内部方法：检查辅助功能权限
            返回: (has_permission, error_message)
            """
            try:
                from ApplicationServices import AXIsProcessTrusted, AXIsProcessTrustedWithOptions, kAXTrustedCheckOptionPrompt

                # 检查当前进程是否有辅助功能权限
                is_trusted = AXIsProcessTrusted()

                if not is_trusted:
                    # 尝试显示权限请求对话框
                    options = {kAXTrustedCheckOptionPrompt: True}
                    is_trusted_with_prompt = AXIsProcessTrustedWithOptions(options)

                    if not is_trusted_with_prompt:
                        return False, "辅助功能权限被拒绝"
                    else:
                        return False, "需要重启程序以使权限生效"

                return True, ""

            except Exception as e:
                return False, f"检查权限时出错: {str(e)}"

        def _get_accessibility_instructions(self):
            """
            获取详细的辅助功能权限设置指导
            """
            return (
                "请按以下步骤操作:\n\n"
                "1. 打开 [系统偏好设置]\n"
                "2. 进入 [安全性与隐私]\n"
                "3. 选择 [隐私] 标签页\n"
                "4. 在左侧列表中找到 [辅助功能]\n"
                "5. 在右侧列表中找到本程序 (或运行它的终端) 并打上勾\n\n"
                "如果列表中没有本程序，请点击 + 号手动添加。\n\n"
                "授权后请重启本程序。"
            )

        def check_requirements(self, show_message_callback):
            """
            (R24) 检测macOS依赖和权限，提供详细的用户引导
            """
            # 检查pyobjc依赖
            try:
                import Cocoa
                import ApplicationServices
                print("R24: pyobjc 已安装。")
            except ImportError:
                show_message_callback(
                    "kqs 窗口布局 - 缺少依赖",
                    "在 macOS 平台运行需要 `pyobjc` 库。\n\n"
                    "请运行: pip install pyobjc\n\n"
                    "或者使用完整安装命令:\n"
                    "pip install pyobjc-framework-Cocoa pyobjc-framework-ApplicationServices",
                    "ok"
                )
                return False

            # 检查辅助功能权限
            has_permission, error_message = self._check_accessibility_permission()
            self.accessibility_checked = True
            self.accessibility_granted = has_permission

            if not has_permission:
                if "需要重启程序" in error_message:
                    show_message_callback(
                        "kqs 窗口布局 - 权限已更新",
                        "辅助功能权限已更新，但需要重启程序才能生效。\n\n"
                        "请重启本程序以继续。",
                        "ok"
                    )
                else:
                    show_message_callback(
                        "kqs 窗口布局 - 需要权限",
                        f"macOS 需要您手动开启\"辅助功能\"权限，本程序才能工作。\n\n"
                        f"{self._get_accessibility_instructions()}",
                        "ok"
                    )
                return False

            print("R24: 辅助功能权限检查通过。")
            return True

        def create_mutex(self, aqq_id, show_message_callback):
            """
            (R24) macOS 单例实现，使用文件锁
            """
            import fcntl
            import os
            import tempfile

            # 在临时目录创建锁文件
            lock_dir = tempfile.gettempdir()
            lock_file_path = os.path.join(lock_dir, f".{aqq_id}_KQS_WinLayout_Mutex_v2.lock")

            try:
                # 创建并打开锁文件
                self.lock_file = open(lock_file_path, 'w')

                # 尝试获取排他锁
                fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)

                # 写入当前进程ID
                self.lock_file.write(str(os.getpid()))
                self.lock_file.flush()

                # 保存aqq_id用于后续释放锁
                self.aqq_id = aqq_id

                print("R24: 程序单例检查通过 (macOS)。")
                return True

            except (IOError, OSError):
                # 获取锁失败，说明程序已在运行
                if hasattr(self, 'lock_file') and self.lock_file:
                    self.lock_file.close()
                    self.lock_file = None

                show_message_callback("kqs 窗口布局", "程序已在运行。", "ok")
                return False

        def release_mutex(self):
            """
            (R24) 释放macOS文件锁
            """
            if hasattr(self, 'lock_file') and self.lock_file:
                try:
                    # 释放文件锁
                    fcntl.flock(self.lock_file, fcntl.LOCK_UN)
                    self.lock_file.close()

                    # 删除锁文件
                    import tempfile
                    import os
                    lock_dir = tempfile.gettempdir()
                    if hasattr(self, 'aqq_id'):
                        lock_file_path = os.path.join(lock_dir, f".{self.aqq_id}_KQS_WinLayout_Mutex_v2.lock")
                        if os.path.exists(lock_file_path):
                            os.remove(lock_file_path)

                    self.lock_file = None
                    print("R24: 互斥锁已释放 (macOS)。")
                except Exception as e:
                    print(f"R24: 释放互斥锁时出错: {e}")

        def get_window_under_cursor(self):
            """
            (R24) macOS实现：获取光标下的窗口信息
            """
            # 检查权限
            if self.accessibility_checked and not self.accessibility_granted:
                return self._handle_accessibility_error("获取光标下窗口信息")

            try:
                from Cocoa import NSEvent
                from ApplicationServices import AXUIElementCopyElementAtPosition, AXUIElementCopyAttributeValue, kAXWindowPositionAttribute, kAXWindowSizeAttribute, kAXTitleAttribute, kAXWindowRoleAttribute, kAXWindowRoleDescriptionAttribute, kAXFocusedWindowAttribute, kAXMainWindowAttribute, kAXWindowAttribute, kAXPIDAttribute, kAXChildrenAttribute, kAXErrorSuccess

                # 获取当前鼠标位置
                mouse_location = NSEvent.mouseLocation()
                # 转换坐标系（Cocoa坐标系原点在左下角）
                screen_frame = NSEvent.mouseLocation()
                from Cocoa import NSScreen
                main_screen = NSScreen.mainScreen()
                screen_frame = main_screen.frame()
                mouse_y = screen_frame.size.height - mouse_location.y

                # 获取鼠标位置的窗口元素
                window_element = AXUIElementCopyElementAtPosition(None, mouse_location.x, mouse_y, None)

                if not window_element[0] == kAXErrorSuccess:
                    return self._handle_accessibility_error("获取光标下窗口信息", f"无法获取窗口元素 (错误代码: {window_element[0]})")

                window_ref = window_element[1]

                # 获取窗口属性
                position = AXUIElementCopyAttributeValue(window_ref, kAXWindowPositionAttribute, None)
                size = AXUIElementCopyAttributeValue(window_ref, kAXWindowSizeAttribute, None)
                title = AXUIElementCopyAttributeValue(window_ref, kAXTitleAttribute, None)

                # 获取窗口ID
                pid = AXUIElementCopyAttributeValue(window_ref, kAXPIDAttribute, None)

                # 获取窗口类名/角色
                role = AXUIElementCopyAttributeValue(window_ref, kAXWindowRoleAttribute, None)

                # 获取屏幕分辨率
                screen_width = int(screen_frame.size.width)
                screen_height = int(screen_frame.size.height)

                # 解析位置和大小
                x = 0
                y = 0
                width = 0
                height = 0

                if position[0] == kAXErrorSuccess and position[1]:
                    x = int(position[1].valueAtIndex_(0))
                    y = int(position[1].valueAtIndex_(1))

                if size[0] == kAXErrorSuccess and size[1]:
                    width = int(size[1].valueAtIndex_(0))
                    height = int(size[1].valueAtIndex_(1))

                # 解析标题
                window_title = ""
                if title[0] == kAXErrorSuccess and title[1]:
                    window_title = str(title[1])

                # 解析PID
                window_pid = 0
                if pid[0] == kAXErrorSuccess and pid[1]:
                    window_pid = int(pid[1])

                # 解析角色
                window_role = ""
                if role[0] == kAXErrorSuccess and role[1]:
                    window_role = str(role[1])

                return {
                    'handle': window_pid,  # 在macOS上使用PID作为句柄
                    'title': window_title,
                    'class_name': window_role,
                    'x': x,
                    'y': y,
                    'width': width,
                    'height': height,
                    'desktop_width': screen_width,
                    'desktop_height': screen_height
                }

            except ImportError:
                print("错误: 需要安装 pyobjc 库")
                return None
            except Exception as e:
                return self._handle_accessibility_error("获取光标下窗口信息", e)

        def get_window_info(self, handle):
            """
            (R24) macOS实现：获取指定句柄的窗口信息
            """
            # 检查权限
            if self.accessibility_checked and not self.accessibility_granted:
                return self._handle_accessibility_error("获取窗口信息")

            try:
                from ApplicationServices import AXUIElementCreateApplication, AXUIElementCopyAttributeValue, kAXWindowPositionAttribute, kAXWindowSizeAttribute, kAXTitleAttribute, kAXWindowRoleAttribute, kAXFocusedWindowAttribute, kAXMainWindowAttribute, kAXWindowAttribute, kAXErrorSuccess

                # 通过PID获取应用程序元素
                app_element = AXUIElementCreateApplication(handle)

                if not app_element:
                    return self._handle_accessibility_error("获取窗口信息", f"无法创建应用程序元素 (PID: {handle})")

                # 获取主窗口
                main_window = AXUIElementCopyAttributeValue(app_element, kAXMainWindowAttribute, None)

                if main_window[0] != kAXErrorSuccess or not main_window[1]:
                    # 尝试获取焦点窗口
                    focused_window = AXUIElementCopyAttributeValue(app_element, kAXFocusedWindowAttribute, None)

                    if focused_window[0] != kAXErrorSuccess or not focused_window[1]:
                        # 尝试获取所有窗口
                        windows = AXUIElementCopyAttributeValue(app_element, kAXWindowAttribute, None)

                        if windows[0] != kAXErrorSuccess or not windows[1] or windows[1].count() == 0:
                            return None

                        window_ref = windows[1].objectAtIndex_(0)
                    else:
                        window_ref = focused_window[1]
                else:
                    window_ref = main_window[1]

                # 获取窗口属性
                position = AXUIElementCopyAttributeValue(window_ref, kAXWindowPositionAttribute, None)
                size = AXUIElementCopyAttributeValue(window_ref, kAXWindowSizeAttribute, None)
                title = AXUIElementCopyAttributeValue(window_ref, kAXTitleAttribute, None)
                role = AXUIElementCopyAttributeValue(window_ref, kAXWindowRoleAttribute, None)

                # 获取屏幕分辨率
                from Cocoa import NSScreen
                main_screen = NSScreen.mainScreen()
                screen_frame = main_screen.frame()
                screen_width = int(screen_frame.size.width)
                screen_height = int(screen_frame.size.height)

                # 解析位置和大小
                x = 0
                y = 0
                width = 0
                height = 0

                if position[0] == kAXErrorSuccess and position[1]:
                    x = int(position[1].valueAtIndex_(0))
                    y = int(position[1].valueAtIndex_(1))

                if size[0] == kAXErrorSuccess and size[1]:
                    width = int(size[1].valueAtIndex_(0))
                    height = int(size[1].valueAtIndex_(1))

                # 解析标题
                window_title = ""
                if title[0] == kAXErrorSuccess and title[1]:
                    window_title = str(title[1])

                # 解析角色
                window_role = ""
                if role[0] == kAXErrorSuccess and role[1]:
                    window_role = str(role[1])

                return {
                    'handle': handle,
                    'title': window_title,
                    'class_name': window_role,
                    'x': x,
                    'y': y,
                    'width': width,
                    'height': height,
                    'desktop_width': screen_width,
                    'desktop_height': screen_height
                }

            except ImportError:
                print("错误: 需要安装 pyobjc 库")
                return None
            except Exception as e:
                return self._handle_accessibility_error("获取窗口信息", e)

        def set_window_layout(self, handle, layout_info):
            """
            (R24) macOS实现：设置窗口布局
            """
            # 检查权限
            if self.accessibility_checked and not self.accessibility_granted:
                return self._handle_accessibility_error("设置窗口布局")

            try:
                from ApplicationServices import AXUIElementCreateApplication, AXUIElementSetAttributeValue, kAXWindowPositionAttribute, kAXWindowSizeAttribute, kAXErrorSuccess
                from Cocoa import NSValue, NSPoint, NSSize

                # 通过PID获取应用程序元素
                app_element = AXUIElementCreateApplication(handle)

                if not app_element:
                    return self._handle_accessibility_error("设置窗口布局", f"无法创建应用程序元素 (PID: {handle})")

                # 获取主窗口
                main_window = AXUIElementCopyAttributeValue(app_element, kAXMainWindowAttribute, None)

                if main_window[0] != kAXErrorSuccess or not main_window[1]:
                    # 尝试获取焦点窗口
                    focused_window = AXUIElementCopyAttributeValue(app_element, kAXFocusedWindowAttribute, None)

                    if focused_window[0] != kAXErrorSuccess or not focused_window[1]:
                        # 尝试获取所有窗口
                        windows = AXUIElementCopyAttributeValue(app_element, kAXWindowAttribute, None)

                        if windows[0] != kAXErrorSuccess or not windows[1] or windows[1].count() == 0:
                            return False

                        window_ref = windows[1].objectAtIndex_(0)
                    else:
                        window_ref = focused_window[1]
                else:
                    window_ref = main_window[1]

                # 获取布局信息
                x, y, width, height = layout_info['x'], layout_info['y'], layout_info['width'], layout_info['height']

                # 设置窗口位置
                position = NSValue.valueWithPoint_(NSPoint(x, y))
                position_result = AXUIElementSetAttributeValue(window_ref, kAXWindowPositionAttribute, position, None)

                # 设置窗口大小
                size = NSValue.valueWithSize_(NSSize(width, height))
                size_result = AXUIElementSetAttributeValue(window_ref, kAXWindowSizeAttribute, size, None)

                if position_result == kAXErrorSuccess and size_result == kAXErrorSuccess:
                    print(f"窗口布局已设置 (handle: {handle})")
                    return True
                else:
                    print(f"设置窗口布局失败 (handle: {handle})")
                    return False

            except ImportError:
                print("错误: 需要安装 pyobjc 库")
                return False
            except Exception as e:
                return self._handle_accessibility_error("设置窗口布局", e)

        def get_screen_metrics(self):
            """
            (R24) macOS实现：获取屏幕分辨率
            """
            try:
                from Cocoa import NSScreen

                main_screen = NSScreen.mainScreen()
                screen_frame = main_screen.frame()

                return {
                    'width': int(screen_frame.size.width),
                    'height': int(screen_frame.size.height)
                }

            except ImportError:
                print("错误: 需要安装 pyobjc 库")
                return {'width': 0, 'height': 0}
            except Exception as e:
                print(f"获取屏幕分辨率时出错: {e}")
                return {'width': 0, 'height': 0}

        def get_foreground_window_handle(self):
            """
            (R24) macOS实现：获取当前活动窗口的句柄
            """
            try:
                from Cocoa import NSWorkspace
                from ApplicationServices import AXUIElementCreateApplication, kAXErrorSuccess

                # 获取当前活动的应用程序
                workspace = NSWorkspace.sharedWorkspace()
                frontmost_app = workspace.frontmostApplication()

                if not frontmost_app:
                    return None

                # 获取应用程序的PID
                pid = frontmost_app.processIdentifier()

                return int(pid)

            except ImportError:
                print("错误: 需要安装 pyobjc 库")
                return None
            except Exception as e:
                print(f"获取当前活动窗口时出错: {e}")
                return None

        def get_ancestor(self, handle):
            """
            (R24) macOS实现：获取窗口的根父窗口
            """
            try:
                from ApplicationServices import AXUIElementCreateApplication, AXUIElementCopyAttributeValue, kAXWindowAttribute, kAXErrorSuccess

                # 通过PID获取应用程序元素
                app_element = AXUIElementCreateApplication(handle)

                if not app_element:
                    return handle

                # 在macOS上，应用程序本身就是根父窗口
                return handle

            except ImportError:
                print("错误: 需要安装 pyobjc 库")
                return handle
            except Exception as e:
                print(f"获取窗口根父窗口时出错: {e}")
                return handle


# --- 平台加载器 ---
def get_platform_manager():
    """
    (R20) 核心: 一次性检测
    根据 sys.platform 加载并返回对应的平台管理器实例。
    """
    if sys.platform == 'win32':
        return WindowsPlatformManager()
    elif sys.platform == 'linux':
        return LinuxPlatformManager()
    elif sys.platform == 'darwin':
        return MacOSPlatformManager()
    else:
        return BasePlatformManager() # 返回一个所有功能都会报错的基类

