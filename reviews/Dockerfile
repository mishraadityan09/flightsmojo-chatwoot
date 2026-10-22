# The reviews bridge: a tiny Node.js container next to the bot (see server.js).
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3003
CMD ["node", "server.js"]
