# NexusChat

A single-instance guest chat application with public groups, direct messages, file and location sharing, and audio and video calls. Express serves the browser UI and HTTP API. Socket.IO manages live presence and chat. SQLite stores messages, attachment metadata, and the guest session signing key. Werift routes call media through an SFU.

## Run locally

NexusChat requires Node.js 24 for its built-in SQLite database. With [nvm](https://github.com/nvm-sh/nvm#nvmrc), run `nvm install` from the project directory to install and select the version in `.nvmrc`. In a new terminal, run `nvm use` before starting the app. If your editor starts the app, select Node.js 24 as its runtime too.

```sh
node --version
npm ci
npm start
```

Open [localhost:3000](http://localhost:3000). Use `npm run dev` to watch the server for changes or `npm test` to run the tests. Copy `.env.example` to `.env` to override configuration. By default, SQLite and attachment files are stored under `data/`.

### Docker Compose with SeaweedFS

Set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in `.env` for the local SeaweedFS instance.

```sh
docker compose up -d --build --wait
```

Compose publishes the chat and media ports on loopback. The S3 gateway and management ports stay on the container network. Named volumes hold the chat database and S3 objects. Open the app at [localhost:3000](http://localhost:3000).

## How guests and conversations work

- Anyone can discover an active group or join a group by name and view its retained history. Names identify guests in the UI. The signed browser session controls ownership of messages across reconnects and restarts. Rejoining with the same browser session and display name replaces the previous connection in that group.
- Guests can message and call people who are currently in the same group. Direct messages and call summaries are available to the same browser guests when they return to the group. Clearing browser cookies or allowing the guest cookie to expire ends access to that guest's previous direct conversations.
- Group and direct histories each retain the latest 50 messages for up to 30 days by default. Attachments are available while their message is retained. Group downloads require current membership, and direct downloads require one of the original guest sessions.
- The server processes messages and relays media. Group calls allow up to eight participants. One-to-one calls require the recipient to accept, and Do Not Disturb blocks incoming calls.

## Deployment

Run one application process against a persistent data volume. Keep SQLite, its WAL, and attachment storage together in the backup and restore plan. The SQLite database includes the guest signing key, so protect it with the same access controls as the message data. Stop the app before taking a filesystem copy, or use SQLite's online backup mechanism.

Set `NODE_ENV=production` and set `PUBLIC_ORIGIN` to the browser-facing HTTPS origin. Terminate TLS at your reverse proxy and forward WebSocket requests as well as HTTP. Enable `TRUST_PROXY` only when exactly one trusted proxy fronts the app. Configure the proxy for uploads up to 50 MB plus multipart overhead.

Choose `STORAGE_TYPE=local` or `STORAGE_TYPE=s3` for the installation. The S3 configuration expects an existing private bucket and credentials with access to check the bucket and read, write, and delete its objects. The app verifies the bucket before it starts listening. Keep the S3 bucket private and configure multipart upload expiration on the object store.

Publish the configured RTC UDP range and set `RTC_ADVERTISED_ADDRESS` to the address clients can reach if the app is behind NAT. Configure `STUN_URL` or a TURN relay as required by the network. For TURN, set `TURN_URL` and the shared `TURN_SECRET` used by the relay's time-limited credentials. Exercise calls from the networks your users will use before rolling out.

Account sign-in, invite-only groups, moderation, and multiple application replicas require a separate design.

## Staging for cross-network calls

Use the [staging deployment guide](deploy/staging/README.md) to run a password-protected HTTPS instance with a dedicated TURN-over-TLS endpoint. Its relay-only policy makes the Wi-Fi and mobile-data test exercise TURN on every browser connection.

## Import existing room history

With the server stopped and before opening the new database to traffic, back up the existing data directory and import its JSON history.

```sh
npm run import:history -- data/message-history.json
```

For Compose, build the image and run the importer against its chat volume before starting the app.

```sh
docker compose build chat-app
docker compose run --rm --no-deps \
  -v "$PWD/data/message-history.json:/history.json:ro" \
  chat-app node scripts/import-history.js /history.json
```

The one-time command imports text and valid location messages within the retention limits. Imported messages keep their timestamps and display names and are read-only because their authors predate guest sessions. Previous attachment objects and the original export stay in the backup for separate review. The running app reads its history from SQLite.
