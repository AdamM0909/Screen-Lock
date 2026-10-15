import datetime as dt
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from screenlock import core  # noqa: E402

RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"  # ASCII "12345678901234567890"


def ts(y, mo, d, h, mi):
    return dt.datetime(y, mo, d, h, mi).timestamp()


class Core(unittest.TestCase):
    def setUp(self):
        self.store = core.Store(tempfile.mkdtemp())
        self.store.data["password"] = core.hash_secret("hunter2", 1000)

    def test_rfc6238_vectors(self):
        for t, want in [(59, "287082"), (1111111109, "081804"), (1234567890, "005924"), (2000000000, "279037")]:
            self.assertEqual(core.totp_code(RFC_SECRET, t // 30), want)

    def test_password_and_cooldown(self):
        self.assertEqual(core.check_secret(self.store, "hunter2", 100)[0], "password")
        for _ in range(4):
            self.assertEqual(core.check_secret(self.store, "nope", 100)[0], "wrong")
        self.assertEqual(core.check_secret(self.store, "nope", 100)[0], "cooldown")
        self.assertEqual(core.check_secret(self.store, "hunter2", 110)[0], "cooldown")
        self.assertEqual(core.check_secret(self.store, "hunter2", 161)[0], "password")

    def test_phone_code_single_use(self):
        self.store.data["totp"] = {"secret": RFC_SECRET, "last_counter": -1}
        now = 1111111109
        code = core.totp_code(RFC_SECRET, now // 30)
        self.assertEqual(core.check_secret(self.store, code, now)[0], "code")
        self.assertEqual(core.check_secret(self.store, code, now)[0], "wrong")
        later = core.totp_code(RFC_SECRET, now // 30 + 1)
        self.assertEqual(core.check_secret(self.store, later, now + 30)[0], "code")

    def test_recovery_code(self):
        rec = core.make_recovery_code()
        self.store.data["recovery"] = core.hash_secret(rec, 1000)
        self.assertEqual(core.check_secret(self.store, rec.lower(), 5)[0], "recovery")

    def test_state_persists(self):
        self.store.save()
        again = core.Store(self.store.dir)
        self.assertTrue(core.verify_secret("hunter2", again.data["password"]))

    def sched(self, days, start, end, sid="a"):
        return {"id": sid, "name": "n", "days": days, "start": start, "end": end, "enabled": True}

    def test_overnight_schedule(self):
        s = [self.sched([4], "21:00", "07:00")]  # Friday night
        fri = dt.datetime(2026, 10, 16, 22, 0)  # a Friday
        self.assertEqual(fri.weekday(), 4)
        self.assertIsNotNone(core.find_window(s, fri))
        sat = dt.datetime(2026, 10, 17, 6, 0)
        w = core.find_window(s, sat)
        self.assertIsNotNone(w)
        self.assertEqual(w[1], dt.datetime(2026, 10, 17, 7, 0))
        self.assertIsNone(core.find_window(s, dt.datetime(2026, 10, 17, 8, 0)))
        self.assertIsNone(core.find_window(s, dt.datetime(2026, 10, 18, 6, 0)))  # Sunday morning: not started Saturday

    def test_same_day_schedule_and_disabled(self):
        s = [self.sched([0, 1, 2, 3, 4], "16:00", "18:00")]
        self.assertIsNotNone(core.find_window(s, dt.datetime(2026, 10, 15, 17, 0)))
        self.assertIsNone(core.find_window(s, dt.datetime(2026, 10, 15, 18, 0)))
        s[0]["enabled"] = False
        self.assertIsNone(core.find_window(s, dt.datetime(2026, 10, 15, 17, 0)))

    def test_manual_timer_expires(self):
        core.start_manual_lock(self.store, 15, now=1000)
        self.assertEqual(core.desired_lock(self.store, 1500)["kind"], "manual")
        self.assertIsNone(core.desired_lock(self.store, 1000 + 15 * 60 + 1))
        self.assertFalse(self.store.data["lock"]["active"])

    def test_early_unlock_skips_only_that_window(self):
        self.store.data["schedules"] = [self.sched([3], "16:00", "18:00")]  # Thursday
        now = ts(2026, 10, 15, 17, 0)
        lock = core.desired_lock(self.store, now)
        self.assertEqual(lock["kind"], "schedule")
        core.finish_unlock(self.store, lock, "password", now)
        self.assertIsNone(core.desired_lock(self.store, now + 60))
        self.assertEqual(core.desired_lock(self.store, ts(2026, 10, 22, 17, 0))["kind"], "schedule")

    def test_manual_beats_skip_and_unlock_clears_manual(self):
        core.start_manual_lock(self.store, None, now=10)
        lock = core.desired_lock(self.store, 20)
        self.assertIsNone(lock["until"])
        core.finish_unlock(self.store, lock, "code", 21)
        self.assertIsNone(core.desired_lock(self.store, 22))

    def test_first_schedule_wins_and_invalid_ignored(self):
        s = [self.sched([3], "10:00", "10:00", "bad"), self.sched([3], "16:00", "18:00", "one"),
             self.sched([3], "16:30", "19:00", "two")]
        sch, _ = core.find_window(s, dt.datetime(2026, 10, 15, 17, 0))
        self.assertEqual(sch["id"], "one")


if __name__ == "__main__":
    unittest.main()
