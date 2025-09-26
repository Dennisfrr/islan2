# Use Node 20 base image
FROM node:20-bookworm

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
# Use dynamic PORT for PaaS; default 3010 for CRM Agent
ENV PORT=3010
EXPOSE 3010

CMD ["sh", "-c", "PORT=${PORT:-3010} npm start"]
