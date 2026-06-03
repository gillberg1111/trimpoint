FROM node:20-alpine
WORKDIR /app

# No dependencies to install — just copy the source.
COPY package.json ./
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://localhost:8080/api/health || exit 1

CMD ["node", "server.js"]
