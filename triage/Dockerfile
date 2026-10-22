# IROP mail triage: a tiny Node.js container between Postfix and Chatwoot (see server.js).
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3004
CMD ["node", "server.js"]
