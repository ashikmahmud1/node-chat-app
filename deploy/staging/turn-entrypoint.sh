#!/bin/sh
set -eu
umask 077

case "${TURN_SECRET}" in
  *[!0-9a-f]*) echo 'STAGING_TURN_SECRET must contain lowercase hexadecimal digits.' >&2; exit 1 ;;
esac
if [ "${#TURN_SECRET}" -ne 64 ]; then
  echo 'STAGING_TURN_SECRET must be 64 characters.' >&2
  exit 1
fi
case "${STAGING_HOST}" in
  ''|*[!a-zA-Z0-9.-]*) echo 'STAGING_HOST must be a DNS hostname.' >&2; exit 1 ;;
esac
case "${SFU_ADDRESS}:${RELAY_ADDRESS}" in
  *[!0-9.:]*) echo 'The SFU and relay addresses must be IPv4 addresses.' >&2; exit 1 ;;
esac

{
  cat /etc/nexus/turnserver.conf
  printf '\nrealm=%s\nstatic-auth-secret=%s\nrelay-ip=%s\nallowed-peer-ip=%s\n' \
    "$STAGING_HOST" "$TURN_SECRET" "$RELAY_ADDRESS" "$SFU_ADDRESS"
} > /tmp/turnserver.conf
unset TURN_SECRET
exec turnserver -c /tmp/turnserver.conf
