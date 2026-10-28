# The API server (and a copy of the built app, served when nothing else does) in one image.
# Built by GitHub Actions and published to GHCR; the NAS only pulls it. See deploy/.
FROM node:24-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml ./
# tsx runs the TypeScript server as it is, so the development dependencies stay.
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY server ./server
COPY src ./src
COPY --from=build /app/dist ./dist
EXPOSE 8787
CMD ["node_modules/.bin/tsx", "server/index.ts"]
