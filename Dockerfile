FROM node:24-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY --chmod=755 entrypoint.sh /entrypoint.sh
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/battle.sqlite
RUN mkdir -p /data
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
