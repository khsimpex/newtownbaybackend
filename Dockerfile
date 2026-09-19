# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm install

# Copy application source
COPY . .

ENV PORT=8000
EXPOSE 8000

# Start development server
CMD ["npm", "run", "dev"]
