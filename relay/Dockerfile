# The relay has no dependencies, so there is no install step and no
# lockfile to drift. Node runs the TypeScript directly (type stripping is
# unflagged from 22.18), which is the same thing `pnpm test` does locally.
#
# Pinned rather than `22-slim`: a relay that silently changes runtime on a
# redeploy is a debugging session nobody scheduled.
FROM node:22.23-slim

# Drop root. This process only ever reads its own source and listens on a
# port, so it has no reason to be able to write anything.
USER node
WORKDIR /app

COPY --chown=node:node . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.ts"]
