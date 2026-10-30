# The demo, the bench and the test suite all run with no PayPal account and no network, so this
# image is enough for a reviewer to reproduce every number in the README.
FROM node:22-alpine

WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY bench/ ./bench/
COPY policy/ ./policy/
COPY tests/ ./tests/
COPY README.md LICENSE ./

# Nothing in the image needs root.
USER node

# Offline by default: no credential, no network, nothing reaches PayPal.
ENV GUARDRAIL_TRANSPORT=mock \
    GUARDRAIL_CREDENTIALS=mock

EXPOSE 7788

CMD ["node", "src/cli.js", "demo"]
