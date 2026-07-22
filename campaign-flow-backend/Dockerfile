FROM node:22-alpine

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# tsx runs TypeScript directly — no separate build step needed.
ENV NODE_ENV=production
EXPOSE 4000

# Default runs the API; the worker service overrides command to `npm run worker:prod`.
CMD ["npm", "run", "start"]
