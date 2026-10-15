"""Windows-only helpers. Every function is a harmless no-op on other systems so the rest can be tested."""
import sys
import threading

IS_WINDOWS = sys.platform == "win32"

if IS_WINDOWS:
    import ctypes
    from ctypes import wintypes
    import winreg

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    WH_KEYBOARD_LL = 13
    WM_KEYDOWN, WM_SYSKEYDOWN, WM_QUIT = 0x0100, 0x0104, 0x0012
    LLKHF_ALTDOWN = 0x20
    VK_TAB, VK_ESCAPE, VK_F4, VK_SPACE = 0x09, 0x1B, 0x73, 0x20
    VK_LWIN, VK_RWIN, VK_CONTROL = 0x5B, 0x5C, 0x11
    SW_MINIMIZE = 6

    class KBDLLHOOKSTRUCT(ctypes.Structure):
        _fields_ = [("vkCode", wintypes.DWORD), ("scanCode", wintypes.DWORD), ("flags", wintypes.DWORD),
                    ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]

    HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)
    user32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, wintypes.HINSTANCE, wintypes.DWORD]
    user32.SetWindowsHookExW.restype = wintypes.HHOOK
    user32.CallNextHookEx.argtypes = [wintypes.HHOOK, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
    user32.CallNextHookEx.restype = ctypes.c_ssize_t
    user32.UnhookWindowsHookEx.argtypes = [wintypes.HHOOK]
    user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
    user32.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    kernel32.GetModuleHandleW.restype = wintypes.HMODULE

    ENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    SHELL_CLASSES = {"Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"}


class KeyboardBlocker:
    """Blocks the Windows key, Alt+Tab, Alt+Esc, Alt+F4, Alt+Space and Ctrl+Esc while the lock is up.

    Ctrl+Alt+Del is handled by Windows itself and cannot be blocked by any program.
    """

    def __init__(self):
        self._thread = None
        self._thread_id = None
        self._ready = threading.Event()

    def start(self):
        if not IS_WINDOWS or self._thread:
            return
        self._ready.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        self._ready.wait(2)

    def stop(self):
        if not IS_WINDOWS or not self._thread:
            return
        user32.PostThreadMessageW(self._thread_id, WM_QUIT, 0, 0)
        self._thread.join(2)
        self._thread = None

    def _run(self):
        self._thread_id = kernel32.GetCurrentThreadId()

        def proc(n_code, w_param, l_param):
            if n_code == 0 and w_param in (WM_KEYDOWN, WM_SYSKEYDOWN):
                info = ctypes.cast(l_param, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents
                vk = info.vkCode
                alt = bool(info.flags & LLKHF_ALTDOWN)
                ctrl = bool(user32.GetAsyncKeyState(VK_CONTROL) & 0x8000)
                if (vk in (VK_LWIN, VK_RWIN)
                        or (alt and vk in (VK_TAB, VK_ESCAPE, VK_F4, VK_SPACE))
                        or (ctrl and vk == VK_ESCAPE)):
                    return 1
            return user32.CallNextHookEx(None, n_code, w_param, l_param)

        self._proc = HOOKPROC(proc)  # keep a reference so it is not garbage collected
        hook = user32.SetWindowsHookExW(WH_KEYBOARD_LL, self._proc, kernel32.GetModuleHandleW(None), 0)
        self._ready.set()
        if not hook:
            return
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))
        user32.UnhookWindowsHookEx(hook)


def minimize_other_windows(own_hwnds=()):
    """Minimize every visible program window except ours and the desktop shell. Games included."""
    if not IS_WINDOWS:
        return
    own = set(own_hwnds)
    buf = ctypes.create_unicode_buffer(256)

    def each(hwnd, _):
        if hwnd in own or not user32.IsWindowVisible(hwnd) or user32.IsIconic(hwnd):
            return True
        user32.GetClassNameW(hwnd, buf, 256)
        if buf.value in SHELL_CLASSES:
            return True
        user32.ShowWindow(hwnd, SW_MINIMIZE)
        return True

    user32.EnumWindows(ENUMPROC(each), 0)


def virtual_screen():
    """(left, top, width, height) of all monitors together, and the primary monitor's (width, height)."""
    if not IS_WINDOWS:
        return (0, 0, 1280, 720), (1280, 720)
    gm = user32.GetSystemMetrics
    return (gm(76), gm(77), gm(78), gm(79)), (gm(0), gm(1))


def top_window_handle(tk_window):
    """Real top-level HWND for a Tk window."""
    if not IS_WINDOWS:
        return 0
    return user32.GetParent(tk_window.winfo_id()) or tk_window.winfo_id()


_POLICY = r"Software\Microsoft\Windows\CurrentVersion\Policies\System"
_RUN = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_NAME = "ScreenLockPC"


def set_task_manager_disabled(disabled):
    """Grey out Task Manager for this Windows user while locked (no admin rights needed)."""
    if not IS_WINDOWS:
        return
    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, _POLICY) as key:
            if disabled:
                winreg.SetValueEx(key, "DisableTaskMgr", 0, winreg.REG_DWORD, 1)
            else:
                try:
                    winreg.DeleteValue(key, "DisableTaskMgr")
                except FileNotFoundError:
                    pass
    except OSError:
        pass


def set_autostart(command):
    """Run at sign-in. Pass a command string to turn on, or None to turn off."""
    if not IS_WINDOWS:
        return
    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, _RUN) as key:
            if command:
                winreg.SetValueEx(key, RUN_NAME, 0, winreg.REG_SZ, command)
            else:
                try:
                    winreg.DeleteValue(key, RUN_NAME)
                except FileNotFoundError:
                    pass
    except OSError:
        pass


def autostart_enabled():
    if not IS_WINDOWS:
        return False
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _RUN) as key:
            winreg.QueryValueEx(key, RUN_NAME)
            return True
    except OSError:
        return False
