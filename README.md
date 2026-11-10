# Node Chat App

A real-time text, file-sharing, geolocation, audio, and video chat application built with Node.js, Express, and Socket.IO.

## Demo
<img src="/Node%20Chat%20App.gif?raw=true" width="800px">

## Project Architecture

```text
node-chat-app/
├── data/                        # Local uploaded files storage
├── public/                      # Static frontend assets
│   ├── css/                     # Stylesheets (styles.css, animate.css)
│   ├── js/                      # Client-side scripts & libraries
│   ├── sound/                   # Notification sound assets
│   ├── index.html               # Room login / join page
│   └── chat.html                # Main chat room & private messaging/calling UI
├── server/                      # Backend application
│   ├── config/                  # Centralized environment & path configuration
│   ├── controllers/             # Express route controllers (upload & download)
│   ├── middlewares/             # Upload (local Multer & AWS S3 v3) & error middlewares
│   ├── routes/                  # Express route definitions
│   ├── sockets/                 # Modular Socket.IO event handlers (chat, private, call)
│   ├── utils/                   # Core utilities (message, users, validation)
│   ├── app.js                   # Express application factory
│   └── server.js                # HTTP & Socket.IO server entry point
├── tests/                       # Unit and integration test suites
├── .env.example                 # Environment variables template
└── package.json
```

## Scripts

- `npm start` — Run the production server (`node server/server.js`)
- `npm run dev` — Run the development server with auto-reload (`nodemon server/server.js`)
- `npm test` — Run the Mocha unit and integration test suite
