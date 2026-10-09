FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8888 \
    DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js AGENT_GUIDE.md ./
COPY public ./public
# Files copied from the host may be owner-only (e.g. 600); make them readable by the non-root user.
RUN chmod -R a+rX /app && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8888
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8888/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--no-warnings", "server.js"]
