FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js index.html ./

EXPOSE 8080
CMD ["node", "server.js"]
