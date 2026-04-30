#!/bin/bash
TS=$(date -u +%Y%m%d-%H%M%S)
DEST=/var/backups/hub/daily
mkdir -p $DEST
tar -czf $DEST/hub-${TS}.tar.gz /var/lib/hub /etc/hub 2>/dev/null
ls -t $DEST/hub-*.tar.gz | tail -n +8 | xargs -r rm
echo "Backup: $DEST/hub-${TS}.tar.gz"
