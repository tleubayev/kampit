FROM node:24-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm@11.19.0 && pnpm install --frozen-lockfile --prod
COPY src ./src
COPY scripts ./scripts
COPY db ./db
COPY public ./public
COPY --chmod=755 entrypoint.sh /entrypoint.sh
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/battle.sqlite
RUN mkdir -p /data
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
