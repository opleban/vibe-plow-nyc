FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js index.html styles.css ./

EXPOSE 8080
CMD ["node", "server.js"]
