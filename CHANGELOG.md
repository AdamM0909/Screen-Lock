# Changelog

## 2.0.0 (2026-10-15)

### Added
- Schedules: lock automatically on chosen days and times, including overnight windows. Locks end by themselves.
  Unlocking early leaves that window unlocked until it ends.
- Timed locks from the popup: 15 minutes, 30 minutes, 1 hour, 2 hours or custom.
- "Lock screen only" mode that blocks the whole browser.
- Redesigned full-page lock screen and unlock box: clock, date, countdown bar, custom message.
- Color themes (Gold, Ember, Neon, Toxic, Violet) and a 24-hour clock option, with a preview.
- Usage log: locks, unlocks and how, wrong passwords, cooldowns and escape attempts, with 7-day totals,
  filters and CSV export.
- Phone unlock with any authenticator app (TOTP, RFC 6238). Codes are single-use. Setup by QR code or setup key.
- Settings page protected by the password, closing itself after 10 minutes.
- Test suite with an in-memory Chrome stand-in.

### Changed
- The unlock box and popup accept either the password or a phone code.
- Wrong tries share one cooldown across the password and phone codes.

## 1.0.0 (2026-10-15)

- First version: lock to one page or one website, optional fullscreen, password with cooldown,
  Ctrl+Shift+Y unlock shortcut, reopen on close, lock again after Chrome restarts.
