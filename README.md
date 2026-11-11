# Node Chat App

A real-time text, file-sharing, geolocation, audio, and video chat application built with Node.js, Express, Socket.IO, WebRTC SFU (`werift`), and SeaweedFS S3-compatible object storage.

## Demo
<img src="/Node%20Chat%20App.gif?raw=true" width="800px">

## Project Architecture

```text
node-chat-app/
├── data/                        # Local uploaded files and message history storage
├── public/                      # Static frontend assets
│   ├── css/                     # Stylesheets (styles.css, animate.css)
│   ├── js/                      # Client-side scripts & libraries (chat.js, deparam.js, etc.)
│   ├── sound/                   # Notification sound assets
│   ├── index.html               # Room login / join page with active room discovery
│   └── chat.html                # Main workspace UI with WebRTC SFU audio/video stages
├── server/                      # Backend application
│   ├── config/                  # Environment, paths, limits, and S3/SeaweedFS configuration
│   ├── controllers/             # Route controllers (upload & S3/local streaming download)
│   ├── middlewares/             # Upload (local & SeaweedFS S3), rate limiting, and error handlers
│   ├── routes/                  # Express route definitions
│   ├── services/                # WebRTC SFU service powered by werift
│   ├── sockets/                 # Socket.IO handlers (chat, private DMs, calling, and SFU signaling)
│   ├── utils/                   # Utilities (logger, message, message-store, users, validation)
│   ├── app.js                   # Express application factory with security headers & metrics
│   └── server.js                # HTTP & Socket.IO server entry point with graceful shutdown
├── tests/                       # Mocha unit and integration test suites
├── Dockerfile                   # Production Alpine container configuration
├── docker-compose.yml           # Multi-container stack (Chat App + SeaweedFS S3 engine)
├── .env.example                 # Environment variables template
└── package.json
```

## Running Locally

### Option A: Local Node.js Development

```bash
# 1. Install dependencies
npm install

# 2. Start the server (runs on http://localhost:3000)
npm run dev # or npm start

# 3. Run unit and integration tests
npm test
```

### Option B: Docker Compose with SeaweedFS S3 Engine

```bash
# Start both SeaweedFS S3 and the Chat App stack
docker compose up -d --build

# View container logs
docker compose logs -f

# Stop the stack
docker compose down
```

The stack automatically boots:
- **SeaweedFS S3 Gateway**: `http://localhost:8333`
- **SeaweedFS Master**: `http://localhost:9333`
- **SeaweedFS Filer**: `http://localhost:8888`
- **NexusChat App**: `http://localhost:3000`
