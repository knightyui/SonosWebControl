FROM node:24-bookworm-slim

WORKDIR /app/web
COPY --chown=node:node web/ ./
RUN mkdir /data && chown node:node /data

USER node
ENV NODE_ENV=production SONOS_DATA_DIR=/data
EXPOSE 38473
CMD ["node", "server.mjs"]
