FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx --no-install tsc --project tsconfig.json
RUN mkdir -p dist/db/migrations \
  && cp src/db/schema.sql dist/db/schema.sql \
  && cp src/db/migrations/*.sql dist/db/migrations/

FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/server.js"]
