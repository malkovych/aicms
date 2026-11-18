from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Iterator, List, Optional

__all__ = ["Client", "Model", "Event", "AicmsError"]

JSON = Dict[str, Any]

# Read-only Actions go over GET, so HTTP caches can keep them.
_READ_ONLY = {"cms.describe", "cms.search", "cms.changes", "cms.review", "cms.history", "cms.agents", "cms.log"}


def _is_read(action: str) -> bool:
    return action in _READ_ONLY or action.endswith(".list") or action.endswith(".get")


class AicmsError(Exception):
    """An error from the server: `code` is one of invalid, unauthorized, forbidden, not_found, conflict, budget."""

    def __init__(self, code: str, message: str, status: int = 0, details: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details

    def __repr__(self) -> str:
        return f"AicmsError({self.code!r}, {self.message!r}, status={self.status})"


@dataclass(frozen=True)
class Event:
    """One live event, e.g. `changeset.merged` with `payload["entries"]`."""

    id: int
    event: str
    payload: Any
    at: str


class Model:
    """The four Actions every model has: list, get, draft, delete."""

    def __init__(self, client: "Client", name: str):
        self._client = client
        self.name = name

    def list(
        self,
        where: Optional[JSON] = None,
        fields: Optional[List[str]] = None,
        order: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        locale: Optional[str] = None,
        format: Optional[str] = None,
    ) -> JSON:
        """`{"items": [...], "total": n, "limit": n, "offset": n}`. `order="-publishedAt"` sorts descending."""
        return self._client.call(f"{self.name}.list", _compact(where=where, fields=fields, order=order, limit=limit, offset=offset, locale=locale, format=format))

    def get(self, id: Optional[str] = None, **by: Any) -> JSON:
        """By id (`get("pos_1")`) or by a unique field (`get(slug="hello")`). Also takes fields, locale, format, drafts."""
        return self._client.call(f"{self.name}.get", _compact(id=id, **by))

    def draft(self, id: Optional[str] = None, **data: Any) -> JSON:
        """Create (no id) or change (with id) an entry in your changeset. Block fields accept Markdown; None clears a field."""
        return self._client.call(f"{self.name}.draft", {**({"id": id} if id else {}), **data})

    def delete(self, id: str) -> JSON:
        """Propose deleting an entry (it takes effect after review)."""
        return self._client.call(f"{self.name}.delete", {"id": id})

    def __repr__(self) -> str:
        return f"<aicms.Model {self.name}>"


class Client:
    """A client for one AICMS site. Models are attributes: `cms.post.list()`."""

    def __init__(self, url: str, token: Optional[str] = None, timeout: float = 30.0, headers: Optional[Dict[str, str]] = None):
        self.url = url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self._headers = dict(headers or {})
        self._models: Dict[str, Model] = {}

    # ---------- transport ----------

    def _request_headers(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        h = {"user-agent": "aicms-python/0.2.0", **self._headers}
        if self.token:
            h["authorization"] = f"Bearer {self.token}"
        h.update(extra or {})
        return h

    def call(self, action: str, input: Optional[JSON] = None, method: Optional[str] = None) -> Any:
        """Call any Action by name, e.g. `call("seo.audit", {"id": "pos_1"})`."""
        input = input or {}
        method = method or ("GET" if _is_read(action) else "POST")
        url = f"{self.url}/api/v1/actions/{urllib.parse.quote(action)}"
        body = None
        if method == "GET":
            if input:
                url += "?" + urllib.parse.urlencode({"input": json.dumps(input, separators=(",", ":"))})
            headers = self._request_headers({"accept": "application/json"})
        else:
            body = json.dumps(input).encode("utf-8")
            headers = self._request_headers({"content-type": "application/json", "accept": "application/json"})
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                return _parse(res.read(), res.status, url)
        except urllib.error.HTTPError as e:
            raise _error_from(e) from None

    # ---------- models ----------

    def model(self, name: str) -> Model:
        """A model by name, for names that clash with client methods (e.g. a model called `search`)."""
        if name not in self._models:
            self._models[name] = Model(self, name)
        return self._models[name]

    def __getattr__(self, name: str) -> Model:
        if name.startswith("_"):
            raise AttributeError(name)
        return self.model(name)

    # ---------- kernel Actions ----------

    def describe(self, model: Optional[str] = None) -> JSON:
        """Start here: models, fields, writing guides and your permissions."""
        return self.call("cms.describe", _compact(model=model))

    def search(self, query: str, model: Optional[str] = None, limit: Optional[int] = None) -> JSON:
        return self.call("cms.search", _compact(query=query, model=model, limit=limit))

    def submit(self, note: Optional[str] = None) -> JSON:
        """Run checks and send your drafts for review. `status` is merged, submitted or needs_changes."""
        return self.call("cms.submit", _compact(note=note))

    def discard(self, id: Optional[str] = None) -> JSON:
        """Drop drafts you haven't submitted: one entry, or all of them."""
        return self.call("cms.discard", _compact(id=id))

    def changes(self, limit: Optional[int] = None) -> JSON:
        """Your recent changesets, with decisions and reviewer comments."""
        return self.call("cms.changes", _compact(limit=limit))

    def review(self, id: Optional[str] = None, status: Optional[str] = None) -> JSON:
        """For reviewers: changesets waiting for a decision, with before/after per field."""
        return self.call("cms.review", _compact(id=id, status=status))

    def merge(self, id: str) -> JSON:
        return self.call("cms.merge", {"id": id})

    def reject(self, id: str, comment: str, final: bool = False) -> JSON:
        return self.call("cms.reject", {"id": id, "comment": comment, **({"final": True} if final else {})})

    def history(self, id: str, version: Optional[int] = None) -> JSON:
        return self.call("cms.history", _compact(id=id, version=version))

    def restore(self, id: str, version: int) -> JSON:
        """Draft a change that restores an entry to an earlier version. Then `submit()`."""
        return self.call("cms.restore", {"id": id, "version": version})

    def revert(self, changeset: str) -> JSON:
        """Draft the undo of a merged changeset. Then `submit()`."""
        return self.call("cms.revert", {"changeset": changeset})

    # ---------- live events ----------

    def events(self, after: Optional[int] = None, reconnect: bool = True, read_timeout: float = 90.0) -> Iterator[Event]:
        """Live events (SSE) from now on, or after event id `after`. Reconnects and resumes; break out of the loop to stop."""
        last = after
        delay = 1.0
        while True:
            headers = self._request_headers({"accept": "text/event-stream"})
            if last is not None:
                headers["last-event-id"] = str(last)
            req = urllib.request.Request(f"{self.url}/api/v1/events", headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=read_timeout) as res:
                    delay = 1.0
                    for kind, data, eid in _sse(res):
                        if eid:
                            last = int(eid)
                        if kind == "ready":
                            try:
                                last = max(last or 0, int(json.loads(data).get("last") or 0))
                            except (ValueError, AttributeError):
                                pass
                            continue
                        try:
                            e = json.loads(data)
                        except ValueError:
                            continue
                        yield Event(id=int(e.get("id", 0)), event=e.get("event", kind), payload=e.get("payload"), at=e.get("at", ""))
            except urllib.error.HTTPError as e:
                raise _error_from(e) from None
            except (urllib.error.URLError, OSError, ConnectionError):
                pass
            if not reconnect:
                return
            time.sleep(delay)
            delay = min(delay * 2, 30.0)

    def __repr__(self) -> str:
        return f"<aicms.Client {self.url}>"


def _compact(**kw: Any) -> JSON:
    return {k: v for k, v in kw.items() if v is not None}


def _parse(raw: bytes, status: int, url: str) -> Any:
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        raise AicmsError("bad_response", f"Expected JSON from {url}, got: {raw[:120]!r}", status) from None


def _error_from(e: urllib.error.HTTPError) -> AicmsError:
    try:
        err = json.loads(e.read().decode("utf-8")).get("error", {})
    except ValueError:
        err = {}
    return AicmsError(err.get("code", "http_error"), err.get("message", f"HTTP {e.code}"), e.code, err.get("details"))


def _sse(res: Any) -> Iterator[tuple]:
    """Yield (event, data, id) from a text/event-stream response."""
    kind, data, eid = "message", [], None
    for raw in res:
        line = raw.decode("utf-8").rstrip("\r\n")
        if not line:
            if data or kind != "message":
                yield kind, "\n".join(data), eid
            kind, data, eid = "message", [], None
            continue
        if line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        value = value[1:] if value.startswith(" ") else value
        if field == "event":
            kind = value
        elif field == "data":
            data.append(value)
        elif field == "id":
            eid = value
