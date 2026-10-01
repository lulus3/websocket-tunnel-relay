FROM node:20-alpine AS production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server/src ./server/src

USER node
EXPOSE 8787

CMD ["node", "server/src/index.mjs"]
