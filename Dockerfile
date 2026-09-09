FROM node:22-alpine
WORKDIR /app
ENV PORT=80
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
EXPOSE 80
CMD ["npm", "start"]
