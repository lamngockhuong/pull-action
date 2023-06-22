# Common build stage
FROM node:16.20-alpine as common-build-stage
USER node
RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node/app
WORKDIR /home/node/app

COPY --chown=node:node package*.json .

# Install dependencies
RUN npm install

# Copy sources
COPY --chown=node:node . .

EXPOSE 3000

# Development build stage
FROM common-build-stage as development-build-stage

ENV NODE_ENV development

# Production build stage
FROM common-build-stage as production-build-stage

ENV NODE_ENV production
