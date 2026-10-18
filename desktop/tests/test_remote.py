import json
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from screenlock import core, remote  # noqa: E402

SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"


class Remote(unittest.TestCase):
    def setUp(self):
        self.store = core.Store(tempfile.mkdtemp())
        self.store.data["password"] = core.hash_secret("hunter2", 1000)
        self.srv = remote.RemoteServer(self.store, port=0, host="127.0.0.1")
        self.srv.start()
        self.base = f"http://127.0.0.1:{self.srv.port}"

    def tearDown(self):
        self.srv.stop()

    def post(self, body, path="/lock"):
        req = urllib.request.Request(self.base + path, json.dumps(body).encode(),
                                     {"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def test_page_and_status(self):
        with urllib.request.urlopen(self.base + "/") as r:
            self.assertIn(b"Screen Lock", r.read())
        with urllib.request.urlopen(self.base + "/status") as r:
            self.assertEqual(json.load(r), {"locked": False})

    def test_lock_with_password(self):
        code, body = self.post({"secret": "hunter2", "minutes": 30, "message": "Back off"})
        self.assertEqual((code, body), (200, {"ok": True}))
        lock = core.desired_lock(self.store)
        self.assertEqual(lock["kind"], "manual")
        self.assertEqual(lock["message"], "Back off")
        with urllib.request.urlopen(self.base + "/status") as r:
            self.assertEqual(json.load(r), {"locked": True})

    def test_lock_with_phone_code_once(self):
        self.store.data["totp"] = {"secret": SECRET, "last_counter": -1}
        import time
        code = core.totp_code(SECRET, int(time.time() // 30))
        self.assertEqual(self.post({"secret": code, "minutes": None})[0], 200)
        self.store.data["lock"] = {"active": False}
        self.assertEqual(self.post({"secret": code, "minutes": 15})[0], 403)  # code already used

    def test_wrong_secret_does_not_lock_and_cooldown(self):
        for _ in range(4):
            self.assertEqual(self.post({"secret": "nope", "minutes": 15})[0], 403)
        self.assertEqual(self.post({"secret": "nope", "minutes": 15})[0], 429)
        self.assertEqual(self.post({"secret": "hunter2", "minutes": 15})[0], 429)
        self.assertIsNone(core.desired_lock(self.store))

    def test_bad_requests(self):
        self.assertEqual(self.post({"secret": "hunter2", "minutes": 99999})[0], 400)
        self.assertEqual(self.post({"secret": "hunter2", "minutes": "x"})[0], 400)
        self.assertEqual(self.post({}, "/nope")[0], 404)
        self.assertIsNone(core.desired_lock(self.store))


if __name__ == "__main__":
    unittest.main()
