# Tab Lock

A Chrome extension that locks the browser to **one tab**, **one website**, or a **full lock screen** until the
password (or a one-time code from your phone) is entered. Built for keeping a younger sibling on one game or
one homework site, or for locking the browser at bedtime.

Works in Chrome on Windows, Mac and Chromebook. Also works in Edge and Brave.

> **Want to lock the whole PC, games included?** See [`desktop/`](desktop/README.md) for Screen Lock for Windows.

## What's new in v2

| Feature | What it does |
|---|---|
| **Schedules** | Lock automatically on chosen days and times (like school nights 9 PM to 7 AM, or weekdays 4 to 6 PM for homework). The lock ends by itself when the time is up. Overnight windows are supported. |
| **Timed locks** | Lock for 15 minutes, 30 minutes, 1 hour, 2 hours or a custom time. A countdown shows on the lock screen. |
| **New lock screen** | Full-page lock screen with a big clock, the date, a countdown bar and a custom message. Five color themes: Gold, Ember, Neon, Toxic, Violet. 12 or 24 hour clock. |
| **Lock screen only mode** | Blocks the whole browser with nothing usable behind it. Good for bedtime. |
| **Usage log** | Records locks, unlocks (and how), wrong passwords, cooldowns, and escape attempts: new tabs, new windows, leaving the page, closing the locked tab, leaving fullscreen. Shows 7-day totals and exports to CSV. |
| **Phone unlock** | Pair any authenticator app (Google Authenticator, Microsoft Authenticator, 2FAS, Authy and others). Its 6-digit code unlocks Tab Lock. Each code works once and expires in 30 seconds, so you can text a code to whoever is at the computer without giving away the password. No server or account needed. |
| **Protected settings** | Schedules, phone unlock and the log are behind the password. Settings close themselves after 10 minutes. |

## Install

1. Download this repository (green **Code** button, then **Download ZIP**) and unzip it somewhere it will stay.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the **`extension`** folder.
5. Click the puzzle piece in the toolbar and pin **Tab Lock**.
6. Recommended: on the extension's **Details** page, turn on **Allow in Incognito** so an Incognito window can't be
   used to get around the lock.

Upgrading from v1: click the reload arrow on the Tab Lock card in `chrome://extensions` after replacing the folder,
or remove v1 and load v2. Your password carries over if you reload in place.

## Use it

**Lock now:** click the padlock, pick what to lock to (this page, this website, or lock screen only), pick how long,
and click **Lock**.

**Unlock:** click the padlock and type the password or a phone code. In fullscreen, press **Ctrl + Shift + Y** to
open the unlock box (it closes itself after 30 seconds). On the lock screen, just start typing. Five wrong tries
start a one-minute cooldown.

**Schedules, phone unlock, log and theme:** click the padlock, then **Schedules, phone unlock, log and settings**
(or right-click the padlock and choose **Options**). You'll be asked for the password.

### Setting up phone unlock

1. Open settings and go to **Phone unlock**, then **Set up phone unlock**.
2. In your authenticator app, add an account and scan the QR code (or choose "Enter a setup key" and type the key).
3. Type the 6-digit code the app shows to confirm. Done.

If codes are rejected, make sure the phone and the computer both set their clocks automatically.

### How schedules behave

- A schedule that crosses midnight (9 PM to 7 AM) counts as starting on the day it begins. Friday 9 PM to 7 AM runs
  Friday night into Saturday morning.
- If someone unlocks early with the password or a phone code, that schedule leaves the browser unlocked until its
  window ends, then works normally next time.
- Schedules are checked every 30 seconds, so a scheduled lock can start up to half a minute late.
- If two schedules overlap, the first one in the list wins.

## Honest limits

Tab Lock is a browser extension, so it can only control the browser.

- It can't stop someone switching to another program, a desktop game, or an Android app on a Chromebook.
- Someone who reaches `chrome://extensions` while it's **unlocked** could turn it off. While locked, every other
  tab is closed, so that page can't be reached.
- Fully quitting Chrome ends the lock for that moment. It locks right back when Chrome opens again (and the log
  shows it).
- When a lock starts, all other tabs and windows are closed. Save anything important first.
- The phone-unlock secret is stored in the extension's private storage, where websites can't read it. Someone with
  full access to the computer's user account could find it. The password itself is never stored, only a salted hash.
- Forgot the password? Remove the extension and load it again. That resets everything, including schedules and
  the log.

For a lock that can't be removed, combine it with a supervised account:

- **Windows:** Microsoft Family Safety (app and game limits, screen time) or Assigned Access (kiosk mode, one app only).
- **Chromebook:** Google Family Link (app limits, screen time, and stops extensions from being removed).

## Project layout

```
extension/
  manifest.json      Chrome extension manifest (MV3)
  background.js      Enforces the lock, runs schedules and timers, writes the log
  lib.js             Shared helpers: password hashing, phone codes (TOTP), schedules, log
  popup.html/.js     Toolbar popup: lock and unlock
  lockscreen.*       Full lock screen, also used by the small unlock box (unlock.html)
  options.html/.js   Settings: schedules, theme, phone unlock, usage log, password
  qr.js              Small QR code generator (no outside dependencies)
  icons/             Toolbar icons
tests/
  fake-chrome.js     In-memory stand-in for the Chrome APIs
  run-tests.js       Tests for locking, escapes, unlocking, phone codes, schedules and timers
```

## Development

No build step and no dependencies. Edit the files in `extension/`, then click the reload arrow on the Tab Lock
card in `chrome://extensions`.

```
npm test        # runs the test suite (Node 20 or newer)
npm run check   # syntax check every script and the manifest
```

The phone-code tests check against the official RFC 6238 test vectors.

## License

MIT. See [LICENSE](LICENSE).
