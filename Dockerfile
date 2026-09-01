# Minimal image for the unified deliberation MCP server.
# Zero third-party runtime deps - only core/ and server/ are needed at runtime.
FROM node:22-alpine

RUN npm install -g mcp-proxy@6.4.3

WORKDIR /app
COPY core ./core
COPY server ./server
COPY package.json ./

USER node

CMD ["mcp-proxy", "--", "node", "server/mcp/index.js"]
