# NexusChat staging

This Compose stack runs a separate, password-protected staging instance. Browsers use one TURN endpoint over TLS on TCP 5349. The app's HTTP and SFU ports and coturn's UDP relay ports stay on a private Docker network. Coturn accepts media permissions only for the SFU. Caddy serves the site on TCP 443.

## Set up the host

1. Use a Linux host with Docker Engine and Docker Compose. Point an IPv4 DNS A record for the staging hostname at the host's public IP. Allow inbound TCP 443 and 5349 in the host and cloud firewalls. If the host is behind NAT, forward those two TCP ports.
2. Obtain a publicly trusted certificate for that hostname. Copy the certificate chain and matching private key to a host directory as `fullchain.pem` and `privkey.pem`. Keep the private key restricted to the deployment administrator. Both services read those files from the directory mounted at `STAGING_TLS_DIR`.
3. Copy `deploy/staging/.env.example` to `deploy/staging/.env`, restrict its permissions with `chmod 600`, and set the hostname, certificate directory, and tester name. Generate a dedicated relay secret with `openssl rand -hex 32`. Generate the tester password's bcrypt hash with `docker run --rm -it caddy:2.11.9-alpine caddy hash-password` and put it in single quotes in the environment file. Share the tester password through a private channel.
4. Start the stack from the repository root.

```sh
docker compose --env-file deploy/staging/.env -p nexus-staging \
  -f deploy/staging/compose.yml up -d --build --wait
```

Use `STAGING_BIND_IP=127.0.0.1` for verification on the deployment machine. For a public staging host, leave it at `0.0.0.0`. The private media network uses `10.253.42.0/24` by default. If it overlaps a route on the host, set `STAGING_MEDIA_SUBNET`, `STAGING_SFU_IP`, and `STAGING_RELAY_IP` together.

After replacing the certificate and key, restart the `web` and `turn` services so both load the renewed files. Restarting TURN interrupts active calls. Staging has its own persistent chat volume and a seven-day message retention period. Use test data.

## Test from two networks

1. Open the staging HTTPS URL on two devices, one on Wi-Fi and the other on mobile data. Turn off Wi-Fi on the mobile-data device. Sign in with the tester credentials and join the same fresh group with different display names.
2. Send a group message, open a direct conversation, and send a direct message. Confirm receipt on the other device.
3. Place a direct audio call, a direct video call, and a group video call. Verify that both users receive audio and video where applicable. If a browser blocks autoplay, select **Play media**.
4. Confirm a selected relay candidate and increasing received packet counts in Firefox's `about:webrtc` or Chrome's `chrome://webrtc-internals`. Record the browser versions, the two networks, the date, and the result.

A call failure at the TURN gathering step calls for checking public TCP 5349, the relay certificate chain, and the shared secret. If relay gathering succeeds and the call still fails, check the private media addresses and coturn's peer permissions. The app requires a TURN candidate before it joins a relay-only call.
