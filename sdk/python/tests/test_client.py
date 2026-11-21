import json
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from aicms import AicmsError, Client


class Stub(BaseHTTPRequestHandler):
    """A tiny stand-in for an AICMS server: records requests, answers like the real one."""

    requests = []
    streams = 0

    def log_message(self, *args):
        pass

    def _json(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        Stub.requests.append(("GET", url.path, urllib.parse.parse_qs(url.query), dict(self.headers), None))
        if url.path == "/api/v1/events":
            Stub.streams += 1
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            start = int(self.headers.get("last-event-id") or 0)
            self.wfile.write(b'event: ready\ndata: {"you":"writer","last":%d}\nretry: 10\n\n' % start)
            self.wfile.write(b": keep-alive\n\n")
            for i in (start + 1, start + 2):
                body = json.dumps({"id": i, "event": "changeset.merged", "payload": {"entries": [{"model": "post"}]}, "at": "2026-11-18T00:00:00Z"})
                self.wfile.write(f"id: {i}\nevent: changeset.merged\ndata: {body}\n\n".encode())
            self.wfile.flush()
            return
        if url.path == "/api/v1/actions/post.get":
            return self._json(404, {"error": {"code": "not_found", "message": "No post with slug \"nope\""}})
        self._json(200, {"items": [{"id": "pos_1", "title": "Hi"}], "total": 1, "limit": 20, "offset": 0})

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        Stub.requests.append(("POST", self.path, None, dict(self.headers), body))
        if body.get("title") == 42:
            return self._json(422, {"error": {"code": "invalid", "message": "Invalid input for \"title\"", "details": {"issues": [{"field": "title"}]}}})
        self._json(200, {"changeset": "cs_1", "op": "create", "id": "pos_2"})


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Stub.requests.clear()
        self.cms = Client(self.url, token="aicms_test")

    def test_reads_use_get_with_json_input(self):
        res = self.cms.post.list(where={"slug": "hi"}, fields=["title"])
        self.assertEqual(res["items"][0]["title"], "Hi")
        method, path, query, headers, _ = Stub.requests[-1]
        self.assertEqual((method, path), ("GET", "/api/v1/actions/post.list"))
        self.assertEqual(json.loads(query["input"][0]), {"where": {"slug": "hi"}, "fields": ["title"]})
        self.assertEqual(headers["Authorization"], "Bearer aicms_test")

    def test_writes_use_post(self):
        res = self.cms.post.draft(title="Hello", body="# Markdown")
        self.assertEqual(res["id"], "pos_2")
        method, path, _, _, body = Stub.requests[-1]
        self.assertEqual((method, path, body), ("POST", "/api/v1/actions/post.draft", {"title": "Hello", "body": "# Markdown"}))
        self.cms.submit(note="Done")
        self.assertEqual(Stub.requests[-1][1:5:3], ("/api/v1/actions/cms.submit", {"note": "Done"}))

    def test_briefs_checks_and_schedules(self):
        self.cms.submit(note="Menu", brief="br_1", publish_at="2026-12-04T09:00:00Z")
        self.assertEqual(Stub.requests[-1][4], {"note": "Menu", "brief": "br_1", "publishAt": "2026-12-04T09:00:00Z"})
        self.cms.check()
        self.assertEqual(Stub.requests[-1][:2], ("GET", "/api/v1/actions/cms.check"))
        self.cms.briefs(status=["open", "blocked"])
        method, path, query, _, _ = Stub.requests[-1]
        self.assertEqual((method, path, json.loads(query["input"][0])), ("GET", "/api/v1/actions/cms.briefs", {"status": ["open", "blocked"]}))
        self.cms.brief_update("br_1", status="blocked", note="Which dishes?")
        self.assertEqual(Stub.requests[-1][4], {"id": "br_1", "status": "blocked", "note": "Which dishes?"})
        self.cms.merge("cs_1", at="2026-12-04T09:00:00Z")
        self.assertEqual(Stub.requests[-1][4], {"id": "cs_1", "at": "2026-12-04T09:00:00Z"})

    def test_errors_carry_code_and_status(self):
        with self.assertRaises(AicmsError) as ctx:
            self.cms.post.get(slug="nope")
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("not_found", 404))
        with self.assertRaises(AicmsError) as ctx:
            self.cms.post.draft(title=42)
        self.assertEqual(ctx.exception.details["issues"][0]["field"], "title")

    def test_models_clash_free(self):
        self.assertIs(self.cms.post, self.cms.model("post"))
        self.assertEqual(self.cms.model("search").name, "search")
        with self.assertRaises(AttributeError):
            self.cms._private

    def test_events_resume_after_reconnect(self):
        seen = []
        for e in self.cms.events():
            seen.append(e.id)
            if len(seen) == 4:
                break
        self.assertEqual(seen, [1, 2, 3, 4], "the second stream resumes after the last id")
        last_stream = [r for r in Stub.requests if r[1] == "/api/v1/events"][-1]
        self.assertEqual(last_stream[3].get("Last-Event-Id") or last_stream[3].get("last-event-id"), "2")


if __name__ == "__main__":
    unittest.main()
