FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY auth.js greeting-cache.js upstream.js server.js index.html ./

EXPOSE 3000
CMD ["node", "server.js"]
