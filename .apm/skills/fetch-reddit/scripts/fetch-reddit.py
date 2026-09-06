#!/usr/bin/env python3
"""Fetch a Reddit post and comments with no app registration required.

Obtains an anonymous app-only token by impersonating the official Reddit
Android client (the technique used by Redlib), then reads oauth.reddit.com.
Falls back to Reddit's RSS feed if the token path fails.
"""

import base64
import html
import json
import os
import random
import re
import string
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from time import time as _now

CLIENT_ID = "ohXpoqrZYub1kg"
TOKEN_URL = "https://www.reddit.com/api/v1/access_token"
OAUTH_BASE = "https://oauth.reddit.com"
WWW_BASE = "https://www.reddit.com"
TOKEN_CACHE = os.path.join(
    os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")),
    "search-reddit", "token.json",
)
TIMEOUT = 15
_ATOM = {"a": "http://www.w3.org/2005/Atom"}


def _ua():
    return f"Reddit/2024.{random.randint(10, 20)}.0/Android {random.randint(10, 14)}"


def _fetch_token():
    device = "".join(random.choice(string.ascii_letters + string.digits) for _ in range(30))
    body = urllib.parse.urlencode({
        "grant_type": "https://oauth.reddit.com/grants/installed_client",
        "device_id": device,
    }).encode()
    basic = base64.b64encode(f"{CLIENT_ID}:".encode()).decode()
    req = urllib.request.Request(TOKEN_URL, data=body, headers={
        "Authorization": f"Basic {basic}",
        "User-Agent": _ua(),
        "Content-Type": "application/x-www-form-urlencoded",
    })
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        token = json.loads(r.read()).get("access_token")
    if not token:
        raise RuntimeError("no access_token in response")
    try:
        os.makedirs(os.path.dirname(TOKEN_CACHE), exist_ok=True)
        fd = os.open(TOKEN_CACHE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump({"access_token": token, "expires_at": _now() + 86400}, f)
    except OSError:
        pass
    return token


def _cached_token():
    try:
        with open(TOKEN_CACHE) as f:
            data = json.load(f)
        if data.get("access_token") and data.get("expires_at", 0) - 120 > _now():
            return data["access_token"]
    except (OSError, ValueError):
        pass
    return None


def _fetch_oauth(path):
    token = _cached_token() or _fetch_token()
    url = f"{OAUTH_BASE}{path}?raw_json=1&limit=100"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}", "User-Agent": _ua()})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        if "json" not in r.headers.get("Content-Type", ""):
            raise RuntimeError("non-JSON response (edge block)")
        return json.loads(r.read())


def _strip(s):
    s = re.sub(r"<[^>]+>", " ", s or "")
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def fetch(url):
    path = urllib.parse.urlparse(url).path.split("?")[0].rstrip("/")
    if not path:
        print(f"Cannot parse a Reddit path from: {url}", file=sys.stderr)
        sys.exit(1)
    try:
        return ("json", _fetch_oauth(path))
    except (urllib.error.URLError, RuntimeError, ValueError):
        req = urllib.request.Request(f"{WWW_BASE}{path}/.rss?limit=25",
                                     headers={"User-Agent": _ua()})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return ("rss", ET.fromstring(r.read()))


def format_comments(children, depth=0):
    indent = "  " * depth
    for child in children:
        if child.get("kind") != "t1":
            continue
        data = child["data"]
        score = data.get("score")
        score = f"{score}" if score is not None else "?"
        print(f"{indent}u/{data.get('author', '?')} ({score}):")
        for line in (data.get("body", "") or "").splitlines():
            print(f"{indent}  {line}")
        print()
        replies = data.get("replies")
        if isinstance(replies, dict):
            format_comments(replies["data"]["children"], depth + 1)


def main():
    if len(sys.argv) < 2:
        print("Usage: fetch-reddit.py <reddit-url>", file=sys.stderr)
        sys.exit(1)

    kind, data = fetch(sys.argv[1])

    if kind == "json":
        post = data[0]["data"]["children"][0]["data"]
        print(f"## {post['title']}")
        print(f"u/{post['author']} | score: {post['score']} | "
              f"upvote: {post.get('upvote_ratio', 0):.0%}")
        print()
        if post.get("selftext"):
            print(post["selftext"])
            print()
        print("---\n")
        format_comments(data[1]["data"]["children"])
    else:
        entries = data.findall("a:entry", _ATOM)
        if not entries:
            print("No content in RSS feed", file=sys.stderr)
            sys.exit(1)
        post = entries[0]
        print(f"## {_strip(post.findtext('a:title', default='', namespaces=_ATOM))}")
        author = (post.findtext("a:author/a:name", default="", namespaces=_ATOM) or "").replace("/u/", "")
        print(f"u/{author} | (via RSS fallback — no scores)")
        print("\n---\n")
        for e in entries[1:]:
            body = _strip(e.findtext("a:content", default="", namespaces=_ATOM))
            if not body or body == "[link] [comments]":
                continue
            a = (e.findtext("a:author/a:name", default="", namespaces=_ATOM) or "").replace("/u/", "")
            print(f"u/{a}:")
            print(f"  {body}\n")


if __name__ == "__main__":
    main()
