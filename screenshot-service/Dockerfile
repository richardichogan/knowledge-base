# Microsoft's Playwright image: Node plus Chromium and its system libraries.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
ENV PORT=8080
EXPOSE 8080
USER pwuser
CMD ["node", "server.mjs"]
