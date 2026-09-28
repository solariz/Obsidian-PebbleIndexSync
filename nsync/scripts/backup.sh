#!/bin/sh
# Note Sync backup: archives store/, config.php and log/ into backups/.
#
# Files under store/, log/ and config.php are 0640 and owned by the app user,
# so run this script as root (or a user with read access), e.g. via cron:
#
#   0 3 * * * /var/www/project/scripts/backup.sh
#
# Make it executable once:
#   chmod +x scripts/backup.sh
#
# Environment:
#   BACKUP_DIR   output directory   (default: <repo>/backups)
#   BACKUP_KEEP  keep backups younger than this many days (default: 14)
set -eu

umask 027

BASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BACKUP_DIR=${BACKUP_DIR:-"$BASE_DIR/backups"}
BACKUP_KEEP=${BACKUP_KEEP:-14}

case $BACKUP_KEEP in
    ''|*[!0-9]*)
        echo "BACKUP_KEEP must be a non-negative integer" >&2
        exit 1
        ;;
esac

mkdir -p "$BACKUP_DIR"
chmod 0750 "$BACKUP_DIR"

set -- store
if [ -d "$BASE_DIR/log" ]; then
    set -- "$@" log
fi
if [ -f "$BASE_DIR/config.php" ]; then
    set -- "$@" config.php
fi

STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/nsync-$STAMP.tar.gz"
tar -czf "$OUT" -C "$BASE_DIR" -- "$@"
chmod 0640 "$OUT"

find "$BACKUP_DIR" -name 'nsync-*.tar.gz' -mtime +"$BACKUP_KEEP" -delete

echo "backup written: $OUT"
