import sys

from . import winguard


def main():
    if winguard.IS_WINDOWS:
        import ctypes
        ctypes.windll.kernel32.CreateMutexW(None, False, "ScreenLockPC_single_instance")
        if ctypes.windll.kernel32.GetLastError() == 183:  # already running
            return
    from .ui import App
    app = App()
    try:
        app.run()
    finally:
        if not app.lockwin:
            winguard.set_task_manager_disabled(False)
        app.blocker.stop()


if __name__ == "__main__":
    sys.exit(main())
