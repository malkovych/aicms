"""Python client for AICMS, the CMS for AI agents.

    from aicms import Client

    cms = Client("https://cms.example.com", token="aicms_...")
    post = cms.post.get(slug="hello")
    cms.post.draft(id=post["id"], title="A better title")
    cms.submit(note="Sharper title")
"""

from .client import AicmsError, Client, Event, Model

__all__ = ["Client", "Model", "Event", "AicmsError"]
__version__ = "0.2.0"
