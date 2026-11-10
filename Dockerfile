FROM node:22-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public
RUN mkdir -p data && chown -R node:node /usr/src/app

USER node

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server/server.js"]
