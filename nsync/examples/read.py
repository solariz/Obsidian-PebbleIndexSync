#!/usr/bin/env python3
"""Note Sync API client examples (list, read, delete).

This script talks to https://nsync.solariz.de/index.php using only the Python 3
standard library (urllib). No pip packages are required.

Auth
----
Every call needs HTTP header ``Token`` with a value listed in config.php
(at least 6 characters). The token is read from the environment so it is
never stored in this file:

    export NSYNC_TOKEN='your-token-here'

Optional:

    export NSYNC_URL='https://nsync.solariz.de/index.php'

Usage
-----
    python3 examples/read.py list
    python3 examples/read.py read 202608211341.pftTsMaG.md
    python3 examples/read.py read 202608211341.pftTsMaG.md -o note.md
    python3 examples/read.py del 202608211341.pftTsMaG.md

A 403 with an empty body means the token was missing or unknown. Filenames
must match YYYYMMDDhhmm.<8-alnum>.md from ``list``.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

DEFAULT_URL = "https://nsync.solariz.de/index.php"


def api_get(url: str, token: str, params: dict[str, str]) -> Any:
    """Send an authenticated GET and return the decoded JSON body.

    Args:
        url: Full index.php URL.
        token: Value for the Token header (not logged here).
        params: Query string fields such as action and filename.

    Returns:
        Parsed JSON (list for ``list``, dict for ``read`` / ``del``).

    Raises:
        SystemExit: On HTTP errors, including empty 403 refusals.
    """
    query = urllib.parse.urlencode(params)
    request = urllib.request.Request(
        f"{url}?{query}",
        headers={
            "Token": token,
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        if err.code == 403:
            print("refused: invalid or missing token (HTTP 403)", file=sys.stderr)
            sys.exit(1)
        print(f"HTTP {err.code}: {body}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as err:
        print(f"request failed: {err.reason}", file=sys.stderr)
        sys.exit(1)

    return json.loads(raw)


def cmd_list(url: str, token: str) -> None:
    """Print all notes visible to this token as JSON.

    Example response item::

        {
          "filename": "202608211341.pftTsMaG.md",
          "date": "2026-08-21T13:41:01",
          "lastmodified": "2026-08-21T13:41:01",
          "title": "Note Ring Fri 21 Aug 13:41"
        }
    """
    notes = api_get(url, token, {"action": "list"})
    print(json.dumps(notes, indent=2, ensure_ascii=False))


def cmd_read(url: str, token: str, filename: str, output: str | None) -> None:
    """Fetch one note. Prints JSON, or writes the markdown if -o is set.

    The JSON always has a ``content`` key with full frontmatter plus body,
    ready to save locally as a .md file.
    """
    payload = api_get(url, token, {"action": "read", "filename": filename})
    if output:
        with open(output, "w", encoding="utf-8") as handle:
            handle.write(payload["content"])
        print(f"wrote {output}")
        return
    print(json.dumps(payload, indent=2, ensure_ascii=False))


def cmd_delete(url: str, token: str, filename: str) -> None:
    """Delete one note owned by this token. Prints {"ok": true} on success."""
    payload = api_get(url, token, {"action": "delete", "filename": filename})
    print(json.dumps(payload, indent=2, ensure_ascii=False))


def parse_args() -> argparse.Namespace:
    """Build the command line: list | read | del."""
    parser = argparse.ArgumentParser(
        description="Call the Note Sync API (list, read, delete).",
        epilog="Set NSYNC_TOKEN before running. Do not pass the token as an argument.",
    )
    parser.add_argument(
        "--url",
        default=os.environ.get("NSYNC_URL", DEFAULT_URL),
        help="API endpoint (default: NSYNC_URL or %(default)s)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="List notes for this token")

    read_p = sub.add_parser("read", help="Read one note by filename")
    read_p.add_argument("filename", help="Note filename from list, e.g. 202608211341.pftTsMaG.md")
    read_p.add_argument("-o", "--output", help="Write markdown to this path instead of JSON")

    del_p = sub.add_parser("del", help="Delete one note by filename")
    del_p.add_argument("filename", help="Note filename from list")

    return parser.parse_args()


def main() -> None:
    """Dispatch list, read, or del after checking NSYNC_TOKEN."""
    args = parse_args()
    token = os.environ.get("NSYNC_TOKEN", "")
    if len(token) < 6:
        print("Set NSYNC_TOKEN to your API token (min 6 characters).", file=sys.stderr)
        sys.exit(1)

    if args.command == "list":
        cmd_list(args.url, token)
    elif args.command == "read":
        cmd_read(args.url, token, args.filename, args.output)
    elif args.command == "del":
        cmd_delete(args.url, token, args.filename)


if __name__ == "__main__":
    main()
