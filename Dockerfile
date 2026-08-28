# Plain Node image, not the Playwright/Chrome one: SportyBet serves every odds
# feed this actor reads as plain JSON over HTTP, so there is no browser to host.
# The browser image also carries a browser-sized default memory allocation,
# which reserves far more of the account allowance than this actor needs.
FROM apify/actor-node:18

COPY package*.json ./
RUN npm --quiet set progress=false \
 && npm install --omit=dev --omit=optional \
 && echo "Installed NPM packages:" \
 && (npm list --omit=dev --all || true)

COPY . ./

CMD ["npm", "start"]
