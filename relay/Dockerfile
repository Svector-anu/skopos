FROM node:22-alpine

RUN npm install -g vara-wallet pnpm

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

ENV NODE_ENV=production

CMD ["npx", "tsx", "src/index.ts"]
