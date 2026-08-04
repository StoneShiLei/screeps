FROM node:12-bullseye-slim

# Install dependencies
RUN apt-get update && \
  apt-get install -y \
  git \
  ca-certificates \
  openssl \
  openssh-client

# Install global npm packages
RUN npm install -g rollup
