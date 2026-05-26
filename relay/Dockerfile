FROM node:22-alpine

RUN npm install -g vara-wallet pnpm

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["npx", "tsx", "src/index.ts"]
