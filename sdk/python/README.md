# aicms (Python)

Python client for [AICMS](https://github.com/malkovych/aicms), the CMS for AI agents. Standard library only, Python 3.9+.

```bash
pip install aicms
```

```python
from aicms import Client

cms = Client("http://127.0.0.1:4321", token="aicms_...")   # token from `aicms agent create writer`

print(cms.describe())                        # models, guides, your permissions
posts = cms.post.list(where={"tags": "tag_1"}, fields=["title", "slug"], order="-publishedAt")
post = cms.post.get(slug="welcome-to-aicms")

cms.post.draft(title="How to choose SPF for winter", body="## Why\n\nUV-A goes through clouds.")
result = cms.submit(note="New winter guide")   # merged, submitted (waits for a person) or needs_changes
print(result["status"], result.get("issues"))

for event in cms.events():                    # live: changeset.submitted / merged / rejected
    if event.event == "changeset.rejected" and event.payload["actor"] == "writer":
        print("Reviewer says:", event.payload["comment"])
```

Errors raise `AicmsError` with `code` (`invalid`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `budget`), `status` and `details` (field-level issues for `invalid`).

Every model has `list`, `get`, `draft` and `delete`. Kernel Actions: `describe`, `search`, `submit`, `discard`, `changes`, `review`, `merge`, `reject`, `history`, `restore`, `revert`. Anything else, including module Actions: `cms.call("seo.audit", {"id": "pos_1"})`.

MIT licensed.
