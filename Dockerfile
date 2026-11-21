FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

# The server never writes to disk, so it runs as the plain node
# user instead of root.
USER node

EXPOSE 3000

CMD ["node", "src/index.js"]
