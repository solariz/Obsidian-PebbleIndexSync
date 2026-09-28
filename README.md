# PebbleIndexSync

Obsidian client for NSync. The Index 01 posts a transcript, NSync holds it, this
plugin writes it into the vault. NSync is a separate PHP service and is not in
this repo.

## What happens on a sync

Three calls to the server:

- `list` to see what's waiting for the token
- `read` to pull one note
- `markasread` to say it's been picked up, so it stops showing up in `list`

The note then goes into the note folder. Default is `Pebble`, and with dated
subfolders on, the path is `Pebble/2026/08/Title.md`. The server filename is
kept in the `nsync-id` frontmatter field. A note that's already in the vault
gets skipped instead of imported again, and that still works if you renamed the
file by hand.

Titles come from the server. If a title collides with a file that's already
there, the plugin puts a number behind it (`Title 2.md`, `Title 3.md`) instead
of overwriting anything.

Daily notes are optional. With the option on, each newly imported note gets
embedded under a heading in the daily note for its capture date, default heading
`## Pebble Index`. The daily note has to come from the core Daily Notes plugin,
because that's where the folder and the date format are read from.

One thing about timing. Capture times come off the server without a timezone, in
Europe/Berlin, and the plugin reads them as local device time. Sit in another
zone and the daily note can land on the wrong day. That's a known limitation,
not a setting.

## Requirements

Obsidian 1.13.0 or newer, a running NSync instance, and a token for it. The
daily note embed also needs the core Daily Notes plugin enabled.

## Install

Download `main.js` and `manifest.json` from the latest release, put both into
`<vault>/.obsidian/plugins/pebble-index-sync/`, reload Obsidian, enable the
plugin. No community listing yet.

## Settings

Endpoint, token, note folder, daily note options, sync schedule. The settings
tab describes each one. The connection test only calls `list`, so it won't write
anything.

## Development

Node 20 or newer.

```sh
npm install
npm test
npm run lint
npm run build
```

`npm run build` writes `main.js` to the project root. It's a build artifact and
isn't committed, so a fresh clone won't have one until you build.

## Releasing

```sh
npm version patch
git push origin main --tags
```

The release tag has to match `version` in `manifest.json` exactly, without a
leading `v`, because Obsidian finds a version's release by its tag. The `.npmrc`
disables npm's default `v` tag prefix so `npm version` produces the right tag;
the workflow rejects anything that doesn't match. It builds the plugin and
creates the release with `main.js`, `manifest.json` and a zip.

## License

MIT, see [LICENSE](LICENSE).

Marco Goetze, [solariz.de](https://solariz.de)
