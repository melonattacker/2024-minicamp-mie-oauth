FROM node:21-alpine

WORKDIR /app

COPY package.json ./

RUN npm i

COPY . .

RUN adduser -D woooker
USER woooker

CMD ["npm", "start"]