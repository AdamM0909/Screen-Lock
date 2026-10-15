# Screen Lock for Windows

Locks the **whole PC**, games like Call of Duty included, until the password or a one-time code from your phone is
entered. This is the companion to the Tab Lock browser extension in `../extension`, with the same password,
schedule and phone-code ideas.

## What it does while locked

- Covers every monitor with a full-screen lock screen (clock, date, countdown, your message, an optional picture, five color themes).
- Minimizes every other program, including games. Nothing is closed, so nothing is lost.
- Blocks the Windows key, Alt+Tab, Alt+Esc, Alt+F4, Alt+Space and Ctrl+Esc.
- Greys out Task Manager for your Windows user, so the lock can't be ended from there.
- Unlocks with the password, the emergency recovery code, or a phone code (any authenticator app). Phone codes work
  once and expire in 30 seconds, so you can text one to someone without sharing the password.
- Five wrong tries start a one-minute cooldown.
- Remembers the lock across a restart: sign back in and it locks again (turn on **Start with Windows**).
- Schedules (like school nights 9 PM to 7 AM), timed locks (15 min to custom), and a log you can export as CSV.

## Install

1. Install Python 3.10 or newer from python.org (tick **Add python.exe to PATH**), or skip this and use the exe below.
2. Open this `desktop` folder in a terminal and run `py -m pip install -r requirements.txt` (draws the phone setup QR code and
   lets you use JPG pictures on the lock screen).
3. Double-click `run_screenlock.pyw`. The first time, choose a password and write down the **recovery code** it shows.
4. In **Settings**, turn on **Start with Windows**.

To make a single `ScreenLock.exe` that needs no Python, run `build.bat`. The exe appears in `dist`.

## Use it

- **Lock screen picture:** Settings → Lock screen picture → Choose. PNG and GIF always work; JPG and others need
  Pillow (installed by the requirements step). Remove clears it. The message text is on the Lock now tab.
- **Lock now:** pick a time on the first tab. Walk away.
- **Unlock:** just start typing on the lock screen, then press Enter.
- **Phone unlock:** Phone unlock tab, scan the QR code with an authenticator app, type the code to confirm.
- Closing the window minimizes it to the taskbar (it keeps running). Reopening it asks for the password again if
  it has been more than 10 minutes. **Settings → Quit** needs the password.

## Honest limits

This is a program, so the Windows sign-in is still stronger. Use both: press **Win + L** when you leave, and keep
your brother on his own standard account without a way to your password.

- **Ctrl+Alt+Del** is handled by Windows and can't be blocked by any program. From there someone can sign out or
  restart. After signing back in the lock comes back, but only if **Start with Windows** is on.
- The lock only exists while the program runs. If it isn't running when he sits down (it wasn't started, or it was
  closed while unlocked), nothing is locked. An admin account can also end it. Run it from your own account
  and keep his a standard one.
- Some games in true exclusive fullscreen can draw over other windows for a moment. The lock re-raises itself
  every fraction of a second and minimizes the game, but pair it with Win + L for important moments.
- Settings and the phone-unlock secret are stored in `%APPDATA%\ScreenLockPC\config.json`. The password is stored
  only as a salted hash, but the phone secret is readable by anyone using your Windows account.
- **Forgot the password?** Use the recovery code on the lock screen. If both are lost, sign in from another admin
  account (or Safe Mode), end `ScreenLock` / `pythonw.exe` in Task Manager, delete `%APPDATA%\ScreenLockPC`, and if
  Task Manager is greyed out, delete the registry value `DisableTaskMgr` under
  `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Policies\System`.

## Development

```
python -m unittest discover -s tests     # core logic: passwords, phone codes (RFC 6238), schedules, timers
```

The logic lives in `screenlock/core.py` and is tested anywhere. `winguard.py` (keyboard blocking, Task Manager,
autostart) and `ui.py` need Windows to run for real.
