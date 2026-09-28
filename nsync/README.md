# Note Sync

Minimal PHP webhook that receives voice transcriptions from a **Pebble Index 01** and stores each one as a timestamped markdown note. Plain PHP, no Composer, no framework, no database — everything is files on disk.

## Description

- Tiny JSON API for **save / list / read / delete / mark-as-read** notes (`htdocs/index.php`)
- Per-device API tokens, each confined to its own `store/<key>/` folder
- Notes are markdown files with YAML frontmatter (`title`, `date`, `modified`, `stored-at`, `hash`)
- After every device that shares a store has read a note, the file is stamped `last-sync` so synced notes can be garbage-collected later
- Optional `debug.php` capture endpoint to inspect raw device payloads
- Optional Ollama integration to title notes with a local model (off by default)
- Python 3 example client for quick testing

## Requirements

- **PHP 8.5+** (any FPM / mod_php setup, no extensions beyond the defaults)
- A web server (Apache, Nginx, …) with **`htdocs/` as document root**
- PHP write access (user `www-data` recommended) to `store/`, `log/`, `debug/`
- **Optional**: `php-curl` and a local Ollama model, only for the disabled-by-default Ollama note titles
- **Python 3** — only needed for `examples/read.py`

## Install

1. Point the web server's document root at `htdocs/`.
2. Copy the template and fill in your own values:

   ```sh
   cp config.sample.php config.php
   ```

   `config.php` lives **next to** `htdocs/` (outside the webroot) and is not
   committed to git. Give each device a token (at least 6 characters) and a
   random 16-character alphanumeric `store_key`. **The example token in
   `config.sample.php` is public — replace it before going live.**

   The sample also ships a disabled `ollama` block. Set `enabled` to `true` to
title notes with a local model instead of the timestamp; it needs `php-curl`
and a pulled model (e.g. `ollama pull qwen3:1.7b`) and falls back to the
timestamp title whenever the model is unavailable. Enable it per token with
`'ollama' => true` in that token's settings. See `DEV.md` for details.

3. Ensure `store/`, `log/`, `debug/` exist and are writable by the web server user — directories `0750`, files `0640`, owned by `www-data`.
4. Point the Pebble Index 01 at `https://your-host/index.php` (save/list/read/delete). Keep `debug.php` handy for payload dumps while testing.
5. Verify with the Python client:

   ```sh
   export NSYNC_TOKEN='your-token'
   python3 examples/read.py list
   ```

### Production notes

- **php.ini**: keep `post_max_size` small (e.g. `2M`) and set `display_errors=Off`, `log_errors=On`. The API rejects note bodies over 20 000 characters with HTTP 413.
- **HTTPS**: redirect HTTP → HTTPS and enable HSTS — the token travels in a request header. Responses already send `Cache-Control: no-store`.
- **Backups**: run `scripts/backup.sh` nightly (as root) to archive `store/`, `config.php` and `log/`.

## Source layout

| Path | What it is |
|---|---|
| `htdocs/` | **Webroot** — the only directory exposed to the web |
| `htdocs/index.php` | Main API: save, list, read, delete + auth + garbage collection |
| `htdocs/debug.php` | Capture endpoint; dumps raw requests when `debug_capture` is on |
| `config.php` | Tokens, timezone, GC settings — outside webroot, **not committed** |
| `lib/ollama-note-title.php` | Optional Ollama helper: generates a title from a note |
| `store/<store-key>/` | Note store, one folder per token |
| `log/` | Daily API logs (`YYYYMMDD.log`) |
| `examples/read.py` | Python 3 stdlib client (`list` / `read` / `del`) |
