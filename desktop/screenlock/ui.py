"""Windows and dialogs (tkinter, which ships with Python)."""
import csv
import datetime as dt
import os
import sys
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from . import core, winguard

FONT = "Segoe UI"


def ask_secret(parent, store, title="Screen Lock", prompt="Enter the password or a phone code"):
    """Modal prompt. Returns the kind of secret accepted ('password', 'recovery', 'code') or None."""
    result = {"v": None}
    win = tk.Toplevel(parent)
    win.title(title)
    win.resizable(False, False)
    win.attributes("-topmost", True)
    ttk.Label(win, text=prompt).grid(row=0, column=0, padx=16, pady=(16, 6))
    entry = ttk.Entry(win, show="•", width=28)
    entry.grid(row=1, column=0, padx=16)
    status = ttk.Label(win, text="", foreground="#b00020")
    status.grid(row=2, column=0, pady=4)

    def submit(_e=None):
        res, left = core.check_secret(store, entry.get())
        if res in ("password", "recovery", "code"):
            result["v"] = res
            win.destroy()
        elif res == "cooldown":
            status.config(text=f"Too many tries. Wait {left} seconds.")
        else:
            status.config(text="That is not right.")
        entry.delete(0, "end")

    row = ttk.Frame(win)
    row.grid(row=3, column=0, pady=(0, 14))
    ttk.Button(row, text="OK", command=submit).pack(side="left", padx=4)
    ttk.Button(row, text="Cancel", command=win.destroy).pack(side="left", padx=4)
    win.bind("<Return>", submit)
    win.bind("<Escape>", lambda e: win.destroy())
    win.protocol("WM_DELETE_WINDOW", win.destroy)
    win.update_idletasks()
    win.geometry("+%d+%d" % ((win.winfo_screenwidth() - win.winfo_width()) // 2,
                             (win.winfo_screenheight() - win.winfo_height()) // 3))
    win.grab_set()
    entry.focus_force()
    parent.wait_window(win)
    return result["v"]


class LockScreen:
    """Full cover over every monitor with a clock, countdown and an unlock box."""

    def __init__(self, app, lock):
        self.app = app
        store = app.store.data
        self.bg, self.fg = core.THEMES.get(store["theme"], core.THEMES["Gold"])
        (left, top, width, height), (pw, ph) = winguard.virtual_screen()
        self.win = tk.Toplevel(app.root)
        w = self.win
        w.overrideredirect(True)
        w.configure(bg=self.bg)
        w.geometry(f"{width}x{height}+{left}+{top}")
        w.attributes("-topmost", True)
        box = tk.Frame(w, bg=self.bg)
        box.place(x=-left + pw // 2, y=-top + ph // 2, anchor="center")
        self.clock = tk.Label(box, bg=self.bg, fg=self.fg, font=(FONT, 88, "bold"))
        self.clock.pack()
        self.date = tk.Label(box, bg=self.bg, fg=self.fg, font=(FONT, 20))
        self.date.pack(pady=(0, 24))
        self.msg = tk.Label(box, bg=self.bg, fg="#ffffff", font=(FONT, 18), wraplength=700)
        self.msg.pack(pady=(0, 18))
        self.bar = tk.Canvas(box, width=420, height=8, bg="#2a2a2a", highlightthickness=0)
        self.bar.pack(pady=(0, 6))
        self.remaining = tk.Label(box, bg=self.bg, fg=self.fg, font=(FONT, 13))
        self.remaining.pack(pady=(0, 22))
        self.entry = tk.Entry(box, show="•", width=22, font=(FONT, 18), justify="center",
                              bg="#1d1d1d", fg="#ffffff", insertbackground="#ffffff", relief="flat")
        self.entry.pack(ipady=6)
        self.status = tk.Label(box, bg=self.bg, fg="#ff6b6b", font=(FONT, 12), text="")
        self.status.pack(pady=(10, 0))
        tk.Label(box, bg=self.bg, fg="#8a8a8a", font=(FONT, 11),
                 text="Type the password or a code from the phone app, then press Enter.").pack(pady=(18, 0))
        w.bind("<Return>", self.submit)
        w.bind("<Key>", lambda e: self.entry.focus_force())
        self.set_lock(lock)
        self.refresh()
        self.keep_on_top()
        self.hide_others()
        self.entry.focus_force()

    def set_lock(self, lock):
        self.lock = lock
        self.msg.config(text=lock.get("message") or self.app.store.data["message"])

    def submit(self, _e=None):
        text = self.entry.get()
        self.entry.delete(0, "end")
        res, left = core.check_secret(self.app.store, text)
        if res in ("password", "recovery", "code"):
            self.app.unlock(res)
        elif res == "cooldown":
            self.status.config(text=f"Too many tries. Try again in {left} seconds.")
        else:
            self.status.config(text="That is not right.")

    def refresh(self):
        if not self.win.winfo_exists():
            return
        now = dt.datetime.now()
        fmt = "%H:%M" if self.app.store.data["clock24"] else "%I:%M %p"
        self.clock.config(text=now.strftime(fmt).lstrip("0"))
        self.date.config(text=now.strftime("%A, %B %d").replace(" 0", " "))
        until, start = self.lock.get("until"), self.lock.get("start")
        self.bar.delete("all")
        if until is None:
            self.remaining.config(text="Locked until unlocked")
        else:
            left = until - time.time()
            at = dt.datetime.fromtimestamp(until).strftime("%I:%M %p").lstrip("0")
            self.remaining.config(text=f"{core.format_remaining(left)} left  •  unlocks at {at}")
            if start and until > start:
                frac = min(1, max(0, left / (until - start)))
                self.bar.create_rectangle(0, 0, 420 * frac, 8, fill=self.fg, width=0)
        self.win.after(500, self.refresh)

    def keep_on_top(self):
        if not self.win.winfo_exists():
            return
        self.win.lift()
        self.win.attributes("-topmost", True)
        if self.win.focus_get() is not self.entry:
            self.entry.focus_force()
        self.win.after(200, self.keep_on_top)

    def hide_others(self):
        if not self.win.winfo_exists():
            return
        winguard.minimize_other_windows([winguard.top_window_handle(self.win)])
        self.win.after(1000, self.hide_others)

    def close(self):
        self.win.destroy()


class App:
    def __init__(self):
        self.store = core.Store()
        self.blocker = winguard.KeyboardBlocker()
        self.root = tk.Tk()
        self.root.title("Screen Lock")
        self.root.geometry("560x520")
        self.lockwin = None
        self.current = None
        self.authed_until = 0
        self.asking = False

    # ----- lifecycle -----
    def run(self):
        d = self.store.data
        if not d["password"]:
            self.first_run()
        else:
            self.root.withdraw()
            if not self.authenticate():
                return
        self.build_panel()
        self.root.protocol("WM_DELETE_WINDOW", self.root.iconify)
        self.root.bind("<Map>", self.on_map)
        if core.desired_lock(self.store):
            self.store.log("relock", "app started while a lock was due")
        else:
            winguard.set_task_manager_disabled(False)
        self.root.deiconify()
        self.tick()
        self.root.mainloop()

    def authenticate(self):
        if ask_secret(self.root, self.store):
            self.authed_until = time.time() + 600
            return True
        return False

    def on_map(self, event):
        if event.widget is not self.root or self.asking or self.lockwin:
            return
        if time.time() > self.authed_until:
            self.asking = True
            try:
                if not self.authenticate():
                    self.root.iconify()
            finally:
                self.asking = False

    def first_run(self):
        win = tk.Toplevel(self.root)
        win.title("Welcome to Screen Lock")
        win.attributes("-topmost", True)
        ttk.Label(win, text="Choose a password. Keep it to yourself.", font=(FONT, 11)).grid(
            row=0, column=0, columnspan=2, padx=16, pady=(16, 8))
        ttk.Label(win, text="Password").grid(row=1, column=0, padx=16, sticky="e")
        a = ttk.Entry(win, show="•", width=24)
        a.grid(row=1, column=1, padx=(0, 16), pady=3)
        ttk.Label(win, text="Again").grid(row=2, column=0, padx=16, sticky="e")
        b = ttk.Entry(win, show="•", width=24)
        b.grid(row=2, column=1, padx=(0, 16), pady=3)
        err = ttk.Label(win, text="", foreground="#b00020")
        err.grid(row=3, column=0, columnspan=2)
        done = {"ok": False}

        def save():
            if len(a.get()) < 4:
                err.config(text="Use at least 4 characters.")
            elif a.get() != b.get():
                err.config(text="The two do not match.")
            else:
                code = core.make_recovery_code()
                self.store.data["password"] = core.hash_secret(a.get())
                self.store.data["recovery"] = core.hash_secret(code)
                self.store.log("setup", "password created")
                self.store.save()
                done["ok"] = True
                messagebox.showinfo(
                    "Recovery code",
                    f"Your emergency recovery code is:\n\n{code}\n\nWrite it down and keep it somewhere your "
                    "brother cannot look. It unlocks the screen if the password is forgotten. "
                    "It is shown only once.", parent=win)
                win.destroy()

        ttk.Button(win, text="Save", command=save).grid(row=4, column=0, columnspan=2, pady=12)
        win.protocol("WM_DELETE_WINDOW", lambda: None)
        win.grab_set()
        self.root.wait_window(win)
        if not done["ok"]:
            sys.exit(0)
        self.authed_until = time.time() + 600

    # ----- locking -----
    def tick(self):
        want = core.desired_lock(self.store)
        if want and not self.lockwin:
            self.engage(want)
        elif want:
            self.current = want
            self.lockwin.set_lock(want)
        elif self.lockwin:
            self.release("ended")
        self.refresh_status()
        self.root.after(1000, self.tick)

    def engage(self, want):
        self.current = want
        if want["kind"] == "schedule":
            self.store.log("schedule_lock", want.get("name", ""))
            self.store.save()
        winguard.set_task_manager_disabled(True)
        self.blocker.start()
        self.root.withdraw()
        self.lockwin = LockScreen(self, want)

    def release(self, how):
        if self.lockwin:
            self.lockwin.close()
            self.lockwin = None
        self.blocker.stop()
        winguard.set_task_manager_disabled(False)
        self.current = None
        self.authed_until = time.time() + 600 if how != "ended" else self.authed_until
        self.root.iconify()

    def unlock(self, how):
        if self.current:
            core.finish_unlock(self.store, self.current, how)
        self.release(how)

    def lock_now(self, minutes, message):
        core.start_manual_lock(self.store, minutes, message)
        self.tick_now()

    def tick_now(self):
        want = core.desired_lock(self.store)
        if want and not self.lockwin:
            self.engage(want)

    # ----- control panel -----
    def build_panel(self):
        nb = ttk.Notebook(self.root)
        nb.pack(fill="both", expand=True, padx=8, pady=8)
        self.build_lock_tab(nb)
        self.build_schedule_tab(nb)
        self.build_phone_tab(nb)
        self.build_settings_tab(nb)
        self.build_log_tab(nb)
        nb.bind("<<NotebookTabChanged>>", lambda e: self.refresh_log())

    def refresh_status(self):
        if not hasattr(self, "status_lbl"):
            return
        w = core.find_window(self.store.data["schedules"], dt.datetime.now())
        self.status_lbl.config(text="Unlocked. A schedule window is active but was unlocked early." if w
                               else "Unlocked. No schedule is running right now.")

    def build_lock_tab(self, nb):
        f = ttk.Frame(nb, padding=16)
        nb.add(f, text="Lock now")
        ttk.Label(f, text="Cover the whole screen, games included.", font=(FONT, 12, "bold")).pack(anchor="w")
        self.status_lbl = ttk.Label(f, text="")
        self.status_lbl.pack(anchor="w", pady=(2, 14))
        ttk.Label(f, text="Message on the lock screen").pack(anchor="w")
        self.msg_var = tk.StringVar(value=self.store.data["message"])
        ttk.Entry(f, textvariable=self.msg_var, width=60).pack(anchor="w", pady=(2, 14))
        ttk.Label(f, text="How long?").pack(anchor="w")
        row = ttk.Frame(f)
        row.pack(anchor="w", pady=6)
        for label, mins in [("15 min", 15), ("30 min", 30), ("1 hour", 60), ("2 hours", 120), ("Until I unlock", None)]:
            ttk.Button(row, text=label, command=lambda m=mins: self.lock_now(m, self.msg_var.get())).pack(
                side="left", padx=3)
        row2 = ttk.Frame(f)
        row2.pack(anchor="w", pady=10)
        ttk.Label(row2, text="Custom minutes:").pack(side="left")
        self.custom = tk.StringVar(value="45")
        ttk.Entry(row2, textvariable=self.custom, width=6).pack(side="left", padx=6)

        def custom_lock():
            try:
                m = int(self.custom.get())
                assert 1 <= m <= 1440
            except (ValueError, AssertionError):
                return messagebox.showerror("Screen Lock", "Enter minutes from 1 to 1440.")
            self.lock_now(m, self.msg_var.get())

        ttk.Button(row2, text="Lock", command=custom_lock).pack(side="left")
        ttk.Label(f, foreground="#666", wraplength=480, text=(
            "Other programs are minimized, not closed, so nothing is lost. Windows, Alt+Tab and Task Manager "
            "are blocked while locked.")).pack(anchor="w", pady=(20, 0))

    def build_schedule_tab(self, nb):
        f = ttk.Frame(nb, padding=12)
        nb.add(f, text="Schedules")
        cols = ("name", "days", "time", "on")
        self.sched_tree = ttk.Treeview(f, columns=cols, show="headings", height=10)
        for c, t, w in [("name", "Name", 140), ("days", "Days", 180), ("time", "Time", 120), ("on", "On", 50)]:
            self.sched_tree.heading(c, text=t)
            self.sched_tree.column(c, width=w)
        self.sched_tree.pack(fill="both", expand=True)
        row = ttk.Frame(f)
        row.pack(pady=8)
        for text, cmd in [("Add", self.add_schedule), ("Edit", self.edit_schedule),
                          ("Turn on/off", self.toggle_schedule), ("Delete", self.delete_schedule)]:
            ttk.Button(row, text=text, command=cmd).pack(side="left", padx=3)
        ttk.Label(f, foreground="#666", wraplength=500, text=(
            "Windows that cross midnight count as starting on the day they begin. Unlocking early skips only "
            "that one window. This app must be running (it starts with Windows if you turn that on in Settings)."
        )).pack(anchor="w")
        self.refresh_schedules()

    def refresh_schedules(self):
        self.sched_tree.delete(*self.sched_tree.get_children())
        for s in self.store.data["schedules"]:
            days = ", ".join(core.DAY_NAMES[d] for d in sorted(s["days"]))
            self.sched_tree.insert("", "end", iid=s["id"], values=(
                s.get("name", ""), days, f'{s["start"]} to {s["end"]}', "yes" if s.get("enabled", True) else "no"))

    def selected_schedule(self):
        sel = self.sched_tree.selection()
        return next((s for s in self.store.data["schedules"] if sel and s["id"] == sel[0]), None)

    def add_schedule(self):
        self.schedule_editor({"id": core.new_id(), "name": "Bedtime", "days": [0, 1, 2, 3, 6],
                              "start": "21:00", "end": "07:00", "enabled": True}, new=True)

    def edit_schedule(self):
        s = self.selected_schedule()
        if s:
            self.schedule_editor(dict(s), new=False)

    def toggle_schedule(self):
        s = self.selected_schedule()
        if s:
            s["enabled"] = not s.get("enabled", True)
            self.store.save()
            self.refresh_schedules()

    def delete_schedule(self):
        s = self.selected_schedule()
        if s and messagebox.askyesno("Screen Lock", f"Delete '{s.get('name', '')}'?"):
            self.store.data["schedules"].remove(s)
            self.store.save()
            self.refresh_schedules()

    def schedule_editor(self, s, new):
        win = tk.Toplevel(self.root)
        win.title("Schedule")
        win.grab_set()
        name, start, end = tk.StringVar(value=s["name"]), tk.StringVar(value=s["start"]), tk.StringVar(value=s["end"])
        ttk.Label(win, text="Name").grid(row=0, column=0, padx=10, pady=6, sticky="e")
        ttk.Entry(win, textvariable=name, width=24).grid(row=0, column=1, columnspan=7, sticky="w")
        days = []
        for i, d in enumerate(core.DAY_NAMES):
            v = tk.BooleanVar(value=i in s["days"])
            days.append(v)
            ttk.Checkbutton(win, text=d, variable=v).grid(row=1, column=i, padx=4, pady=6)
        ttk.Label(win, text="Lock from (24h HH:MM)").grid(row=2, column=0, columnspan=3, padx=10, sticky="e")
        ttk.Entry(win, textvariable=start, width=8).grid(row=2, column=3, columnspan=2)
        ttk.Label(win, text="until").grid(row=3, column=0, columnspan=3, padx=10, sticky="e", pady=6)
        ttk.Entry(win, textvariable=end, width=8).grid(row=3, column=3, columnspan=2)

        def save():
            s.update(name=name.get().strip() or "Schedule", start=start.get().strip(), end=end.get().strip(),
                     days=[i for i, v in enumerate(days) if v.get()])
            if not core.valid_schedule(s):
                return messagebox.showerror("Screen Lock", "Pick at least one day and two different times like 21:00.",
                                            parent=win)
            lst = self.store.data["schedules"]
            if new:
                lst.append(s)
            else:
                lst[[x["id"] for x in lst].index(s["id"])] = s
            self.store.log("schedule_saved", s["name"])
            self.store.save()
            self.refresh_schedules()
            win.destroy()

        ttk.Button(win, text="Save", command=save).grid(row=4, column=0, columnspan=8, pady=12)

    def build_phone_tab(self, nb):
        f = ttk.Frame(nb, padding=16)
        nb.add(f, text="Phone unlock")
        ttk.Label(f, wraplength=480, text=(
            "Pair any authenticator app (Google Authenticator, Microsoft Authenticator, 2FAS, Authy). Its 6-digit "
            "code unlocks the screen. Each code works once and expires in about 30 seconds, so you can text one "
            "to whoever is at the computer without giving away the password.")).pack(anchor="w")
        self.phone_lbl = ttk.Label(f, font=(FONT, 11, "bold"))
        self.phone_lbl.pack(anchor="w", pady=14)
        row = ttk.Frame(f)
        row.pack(anchor="w")
        ttk.Button(row, text="Set up phone unlock", command=self.setup_phone).pack(side="left", padx=(0, 6))
        ttk.Button(row, text="Turn off", command=self.remove_phone).pack(side="left")
        ttk.Label(f, foreground="#666", wraplength=480, text=(
            "If codes are rejected, make sure the phone and this computer both set their clocks automatically.")
                  ).pack(anchor="w", pady=14)
        self.refresh_phone()

    def refresh_phone(self):
        self.phone_lbl.config(text="Phone unlock is ON" if self.store.data["totp"] else "Phone unlock is off")

    def setup_phone(self):
        secret = core.new_totp_secret()
        uri = core.otpauth_uri(secret, os.environ.get("COMPUTERNAME", "This PC"))
        win = tk.Toplevel(self.root)
        win.title("Set up phone unlock")
        win.grab_set()
        ttk.Label(win, text="1. In your authenticator app, add an account and scan this.").pack(padx=14, pady=(14, 6))
        try:
            import segno
            matrix = segno.make(uri, error="m", micro=False).matrix
            cell, quiet = 5, 4
            size = (len(matrix) + quiet * 2) * cell
            cv = tk.Canvas(win, width=size, height=size, bg="white", highlightthickness=0)
            cv.pack()
            for y, r in enumerate(matrix):
                for x, bit in enumerate(r):
                    if bit:
                        px, py = (x + quiet) * cell, (y + quiet) * cell
                        cv.create_rectangle(px, py, px + cell, py + cell, fill="black", width=0)
        except ImportError:
            ttk.Label(win, text="(QR code needs 'pip install segno'. Use the setup key instead.)").pack()
        ttk.Label(win, text="No camera? Choose 'Enter a setup key' and type:").pack(pady=(10, 0))
        key = ttk.Entry(win, width=40, justify="center")
        key.insert(0, secret)
        key.configure(state="readonly")
        key.pack(pady=4)
        ttk.Label(win, text="2. Type the 6-digit code it shows to confirm:").pack(pady=(10, 4))
        code = ttk.Entry(win, width=10, justify="center")
        code.pack()
        err = ttk.Label(win, text="", foreground="#b00020")
        err.pack()

        def confirm():
            c = core.verify_totp(secret, code.get().replace(" ", ""), time.time())
            if c is None:
                err.config(text="That code does not match. Try the next one.")
                return
            self.store.data["totp"] = {"secret": secret, "last_counter": c}
            self.store.log("phone_on", "")
            self.store.save()
            self.refresh_phone()
            win.destroy()

        ttk.Button(win, text="Confirm", command=confirm).pack(pady=12)

    def remove_phone(self):
        if self.store.data["totp"] and messagebox.askyesno("Screen Lock", "Turn off phone unlock?"):
            self.store.data["totp"] = None
            self.store.log("phone_off", "")
            self.store.save()
            self.refresh_phone()

    def build_settings_tab(self, nb):
        f = ttk.Frame(nb, padding=16)
        nb.add(f, text="Settings")
        d = self.store.data
        ttk.Label(f, text="Lock screen color").grid(row=0, column=0, sticky="w", pady=4)
        self.theme = tk.StringVar(value=d["theme"])
        ttk.Combobox(f, textvariable=self.theme, values=list(core.THEMES), state="readonly", width=12).grid(
            row=0, column=1, sticky="w")
        self.clock24 = tk.BooleanVar(value=d["clock24"])
        ttk.Checkbutton(f, text="24-hour clock", variable=self.clock24).grid(row=1, column=0, columnspan=2, sticky="w")
        self.autostart = tk.BooleanVar(value=winguard.autostart_enabled())
        ttk.Checkbutton(f, text="Start with Windows (needed for schedules and to relock after a restart)",
                        variable=self.autostart).grid(row=2, column=0, columnspan=2, sticky="w", pady=4)
        ttk.Button(f, text="Save settings", command=self.save_settings).grid(row=3, column=0, pady=10, sticky="w")
        ttk.Separator(f).grid(row=4, column=0, columnspan=3, sticky="ew", pady=10)
        ttk.Label(f, text="New password").grid(row=5, column=0, sticky="w")
        self.pw1 = ttk.Entry(f, show="•", width=22)
        self.pw1.grid(row=5, column=1, pady=2)
        ttk.Label(f, text="Again").grid(row=6, column=0, sticky="w")
        self.pw2 = ttk.Entry(f, show="•", width=22)
        self.pw2.grid(row=6, column=1, pady=2)
        ttk.Button(f, text="Change password", command=self.change_password).grid(row=7, column=0, pady=8, sticky="w")
        ttk.Button(f, text="Make a new recovery code", command=self.new_recovery).grid(row=7, column=1, sticky="w")
        ttk.Separator(f).grid(row=8, column=0, columnspan=3, sticky="ew", pady=10)
        ttk.Button(f, text="Quit Screen Lock", command=self.quit).grid(row=9, column=0, sticky="w")

    def save_settings(self):
        d = self.store.data
        d["theme"], d["clock24"], d["message"] = self.theme.get(), self.clock24.get(), self.msg_var.get()
        self.store.save()
        winguard.set_autostart(self.autostart_command() if self.autostart.get() else None)
        messagebox.showinfo("Screen Lock", "Saved.")

    def autostart_command(self):
        if getattr(sys, "frozen", False):
            return f'"{sys.executable}"'
        pyw = sys.executable.replace("python.exe", "pythonw.exe")
        launcher = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "run_screenlock.pyw")
        return f'"{pyw}" "{launcher}"'

    def change_password(self):
        if len(self.pw1.get()) < 4 or self.pw1.get() != self.pw2.get():
            return messagebox.showerror("Screen Lock", "Use at least 4 characters, typed the same twice.")
        self.store.data["password"] = core.hash_secret(self.pw1.get())
        self.store.log("password_changed", "")
        self.store.save()
        self.pw1.delete(0, "end")
        self.pw2.delete(0, "end")
        messagebox.showinfo("Screen Lock", "Password changed.")

    def new_recovery(self):
        code = core.make_recovery_code()
        self.store.data["recovery"] = core.hash_secret(code)
        self.store.log("recovery_changed", "")
        self.store.save()
        messagebox.showinfo("Recovery code", f"New recovery code:\n\n{code}\n\nThe old one no longer works. "
                            "Write this one down. It is shown only once.")

    def quit(self):
        if ask_secret(self.root, self.store, prompt="Enter the password to quit"):
            winguard.set_task_manager_disabled(False)
            self.root.destroy()

    def build_log_tab(self, nb):
        f = ttk.Frame(nb, padding=8)
        nb.add(f, text="Log")
        self.log_tree = ttk.Treeview(f, columns=("t", "k", "d"), show="headings", height=14)
        for c, t, w in [("t", "When", 150), ("k", "What", 140), ("d", "Details", 200)]:
            self.log_tree.heading(c, text=t)
            self.log_tree.column(c, width=w)
        self.log_tree.pack(fill="both", expand=True)
        ttk.Button(f, text="Export CSV", command=self.export_log).pack(pady=6)

    def refresh_log(self):
        self.log_tree.delete(*self.log_tree.get_children())
        for e in reversed(self.store.data["log"][-300:]):
            when = dt.datetime.fromtimestamp(e["t"]).strftime("%b %d  %I:%M:%S %p")
            self.log_tree.insert("", "end", values=(when, e["kind"].replace("_", " "), e["detail"]))

    def export_log(self):
        path = filedialog.asksaveasfilename(defaultextension=".csv", initialfile="screen-lock-log.csv")
        if path:
            with open(path, "w", newline="", encoding="utf-8") as fh:
                w = csv.writer(fh)
                w.writerow(["time", "event", "details"])
                for e in self.store.data["log"]:
                    w.writerow([dt.datetime.fromtimestamp(e["t"]).isoformat(sep=" "), e["kind"], e["detail"]])
