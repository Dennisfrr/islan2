FROM node:20-bookworm

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
# Use dynamic PORT (default 3005)
ENV PORT=3005
EXPOSE 3005

# Executa a API do agente (carrega index.js internamente e inicia o bot)
CMD ["sh", "-c", "PORT=${PORT:-3005} npm run dashboard"]


