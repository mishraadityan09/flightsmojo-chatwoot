# The bot's housing: a tiny Node.js container, fifth service in the stack.
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3002
CMD ["node", "server.js"]
