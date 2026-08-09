FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js index.html ./
EXPOSE 8080
CMD ["node", "server.js"]
