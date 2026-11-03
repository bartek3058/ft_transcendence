FROM node:22.23.3-bookworm-slim

WORKDIR /usr/src/app

# openssl: TLS/dev cert tooling. stockfish: the UCI chess engine behind the AI
# opponent and move hints (installed to /usr/games/stockfish on Debian).
RUN apt-get update -y && apt-get install -y openssl stockfish && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm ci

COPY . .

RUN npx prisma generate

EXPOSE 3000

CMD ["npm", "run", "start:dev"]
