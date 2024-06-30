const path = require("path");
const fs = require('fs');
const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const logger = require("morgan");
const { v4: uuidv4 } = require("uuid");
const moment = require('moment-timezone');

const HOST = process.env.HOST;
const PORT = process.env.PORT;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";

const app = express();

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

app.use(logger("common"));
app.use(bodyParser.urlencoded({ extended: true }));

// Redis
const Redis = require("ioredis");
let redisClient = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
});
redisClient.set("queued_count", 0);
redisClient.set("proceeded_count", 0);

// Session
const session = require("express-session");
const RedisStore = require("connect-redis").default;
app.use(session({
  name: "server-session",
  store: new RedisStore({ client: redisClient }),
  secret: crypto.randomBytes(16).toString("hex"),
  resave: false,
  saveUninitialized: true
}));

// Save no cache
app.use(function(req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  return next();
});

// data store
const codes = new Map();
const access_tokens = new Map();
const users = [
  {
    user_id: uuidv4(),
    username: "admin",
    password: ADMIN_PASSWORD,
    access_log: [],
    images: [
      "/images/ramen1.jpg",
      "/images/ramen2.jpg",
      "/images/ramen3.jpg",
      "/images/ramen4.jpg",
      "/images/ramen5.jpg",
      "/images/ramen6.jpg",
    ]
  },
  {
    user_id: uuidv4(),
    username: "guest",
    password: "guest",
    access_log: [],
    last_access_ip_address: null,
    images: [
      "/images/animal1.jpg",
      "/images/animal2.jpg",
      "/images/animal3.jpg",
      "/images/animal4.jpg",
      "/images/animal5.jpg",
      "/images/animal6.jpg",
    ]
  },
];
const clients = [
  {
    client_id: "oauth-client",
    client_secret: CLIENT_SECRET,
    redirect_uris: [`${CLIENT_URL}/callback`],
    scopes: ["image", "profile"]
  }
];

function findUser(username, password) {
  return users.find(user => user.username === username && user.password === password);
}

function getClientById(client_id) {
  return clients.find(client => client.client_id === client_id);
}

function getUserById(user_id) {
  return users.find(user => user.user_id === user_id);
}

app.get('/register', (req, res) => {
  res.render("register");
});

// Register Endpoint
app.post("/register", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: "invalid_request", error_description: "Missing required fields" });
    return;
  }

  const existingUser = users.find(user => user.username === username);
  if (existingUser) {
    res.status(400).json({ error: "invalid_request", error_description: "Username already taken" });
    return;
  }

  // 画像はランダムに選択
  // /image/ramen{1-6}, /image/animal{1-6}のいずれかから必ず6枚を取得
  // 重複はなし
  const images = [];
  const imageDir = __dirname + "/images";
  const ramenImages = fs.readdirSync(imageDir).filter(file => file.startsWith("ramen"));
  const animalImages = fs.readdirSync(imageDir).filter(file => file.startsWith("animal"));
  const randomRamenImages = ramenImages.sort(() => Math.random() - 0.5).slice(0, 3);
  const randomAnimalImages = animalImages.sort(() => Math.random() - 0.5).slice(0, 3);
  images.push(...randomRamenImages.map(image => `/images/${image}`));
  images.push(...randomAnimalImages.map(image => `/images/${image}`));

  const newUser = {
    user_id: uuidv4(),
    username: username,
    password: password,
    access_log: [],
    images: images
  };

  users.push(newUser);

  res.status(201).json({ 
    user_id: newUser.user_id,
    username: newUser.username,
    access_log: [],
  });
});

// Authorization Endpoint
app.get("/auth", (req, res) => {
  let { response_type, client_id, redirect_uri, scopes, state } = req.query;
  const client = getClientById(client_id);

  if (!client) {
    res.status(400).json({ error: "invalid_request", error_description: "invalid client_id" });
    return;
  }

  let redirectUrl;
  try {
    redirectUrl = new URL(redirect_uri);
  } catch(err) {
    res.status(400).json({ error: "invalid_request", error_description: "invalid redirect_uri" });
    return;
  }

  // TODO: check redirect_uri
  // if (!client.redirect_uris.includes(redirectUrl.origin+redirectUrl.pathname)) {
  //   res.status(400).json({ error: "invalid_request", error_description: "invalid redirect_uri" });
  //   return;
  // }

  if (response_type !== "code") {
    res.status(400).json({ error: "invalid_request", error_description: "invalid response_type" });
    return;
  }

  scopes = scopes.split(" ");

  req.session.client = client;
  req.session.scopes = scopes;
  req.session.redirect_uri = redirect_uri;
  req.session.state = state;

  res.render("approve", { 
    client_id: client_id, 
    scopes: scopes 
  });
});

app.post("/approve", (req, res) => {
  const { username, password, approved } = req.body;
  if (!req.session.client || !req.session.scopes || !req.session.redirect_uri ) {
    res.status(401).json({ error: "access_denied", error_description: "session not found" });
    return;
  }

  const client = req.session.client;
  const scopes = req.session.scopes;
  const redirect_uri = req.session.redirect_uri;
  const state = req.session.state;

  req.session.destroy();

  const redirectUrl = new URL(redirect_uri);

  if (!approved) {
    redirectUrl.searchParams.append("error", "access_denied");
    redirectUrl.searchParams.append("error_description", "The request was not approved");
    redirectUrl.searchParams.append("state", state); // Include state in error response
    res.redirect(redirectUrl.href);
    return;
  }

  const user = findUser(username, password);
  if (!user) {
    redirectUrl.searchParams.append("error", "access_denied");
    redirectUrl.searchParams.append("error_description", "End-user authentication failed");
    redirectUrl.searchParams.append("state", state); // Include state in error response
    res.redirect(redirectUrl.href);
    return;
  }

  const expires_at = new Date(Date.now());
  expires_at.setMinutes(expires_at.getMinutes() + 10); // valid in 10 minutes

  const code = {
    user_id: user.user_id,
    client_id: client.client_id,
    scopes: scopes,
    redirect_uri: redirect_uri,
    expires_at: expires_at,
    value: crypto.randomBytes(16).toString("hex")
  }

  codes.set(code.value, code);
  redirectUrl.searchParams.append("code", code.value);
  redirectUrl.searchParams.append("state", state);
  res.redirect(redirectUrl.href);
});

// Token Endpoint
app.post("/token", (req, res) => {
  const { grant_type, redirect_uri } = req.body;

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    res.status(401).json({ error: "invalid_request" });
    return;
  }

  const base64Credentials = authHeader.slice(6);
  const credentials = Buffer.from(base64Credentials, "base64").toString("utf8");
  const [clientId, clientSecret] = credentials.split(':');
  const client = getClientById(clientId);
  if (!client) {
    res.status(401).json({ error: "access_denied" });
    return;
  }
  if (client.client_secret !== clientSecret) {
    res.status(401).json({ error: "access_denied" });
    return;
  }

  if (grant_type !== "authorization_code") {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

  if (!req.body.code) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  const codeValue = Array.isArray(req.body.code)? req.body.code.slice(-1)[0] : req.body.code;
  const code = codes.get(codeValue);
  if (code === undefined) {
    res.status(400).json({ 
      error: "invalid_grant",
      error_description: "The authorization code is not found."
    });
    return;
  }

  const now = new Date(Date.now());
  if (now > code.expires_at) {
    codes.delete(code.value);
    res.status(400).json({ 
      error: "invalid_grant",
      error_description: "The authorization code has expired."
    });
    return;
  }

  // TODO: check redirect_uri
  // const redirectUrl =  new URL(code.redirect_uri);
  // if (redirect_uri !== redirectUrl.origin+redirectUrl.pathname) {
  //   res.status(400).json({ 
  //     error: "invalid_grant",
  //     error_description: "redirect_uri is wrong."
  //   });
  //   return;
  // }

  if (client.client_id !== code.client_id) {
    res.status(400).json({ 
      error: "invalid_grant",
      error_description: "client_id is wrong."
    });
    return;
  }
  codes.delete(code.value);

  const expires_at = new Date(Date.now());
  expires_at.setMinutes(expires_at.getMinutes() + 60); // valid in 60 minutes

  const access_token = {
    user_id: code.user_id,
    client_id: code.client_id,
    scopes: code.scopes,
    expires_at: expires_at,
    value: crypto.randomBytes(32).toString("hex")
  }
  access_tokens[access_token.value] = access_token;

  const user = getUserById(code.user_id);
  if (!user) {
    res.status(500).json({ error: "internal server error" });
    return;
  }

  res.status(200).json({ 
    access_token: access_token.value,
    token_type: "Bearer",
    expires_in: 3600,
    scopes: access_token.scopes
  });
});

// 画像を返すエンドポイント
app.get("/images", (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "invalid_request", error_description: "Access token is missing or invalid" });
    return;
  }

  const tokenValue = authHeader.slice(7);
  const token = access_tokens[tokenValue];
  if (!token) {
    res.status(401).json({ error: "invalid_request", error_description: "Access token is invalid" });
    return;
  }

  const now = new Date(Date.now());
  if (now > token.expires_at) {
    delete access_tokens[tokenValue];
    res.status(401).json({ error: "invalid_request", error_description: "Access token has expired" });
    return;
  }

  const user = getUserById(token.user_id);
  if (!user) {
    res.status(500).json({ error: "internal server error" });
    return;
  }

  // 画像をbase64エンコードして返す
  const images = user.images;
  const imageBase64s = [];
  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    // ファイル読み込み
    const imageBase64 = fs.readFileSync(__dirname + image, 'base64');
    imageBase64s.push(imageBase64);
  }


  const access_time = moment().tz("Asia/Tokyo").format(); // JSTで設定
  const access_ip_address = req.ip; // リクエスト送信元のIPアドレスを設定
  user.access_log.push({ access_time, access_ip_address });

  res.status(200).json({ 
    user_id: user.user_id,
    username: user.username,
    access_log: user.access_log,
    images: imageBase64s
  });
});


// ユーザー情報（パスワード以外）を返すエンドポイント
app.get("/user/:username", (req, res) => {
  const { username } = req.params;
  const user = users.find(user => user.username === username);
  if (!user) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  res.status(200).json({
    user_id: user.user_id,
    username: user.username,
    access_log: user.access_log,
  });
});

app.get("/report", async (req, res, next) => {
  res.render("report", {
    openRedirectSuccess: "",
    openRedirectError: "",
    csrfSuccess: "",
    csrfError: ""
  });
});

app.post("/report/open-redirect", async (req, res, next) => {
  // Parameter check
  const { path } = req.body;
  if (!path || path === "") {
    return res.render("report", {
      openRedirectSuccess: "",
      openRedirectError: "invalid parameter",
      csrfSuccess: "",
      csrfError: ""
    });
  }
  let query = {"type": "open-redirect", "path": path};
  query = JSON.stringify(query);

  try {
    // Enqueued jobs are processed by crawl.js
    redisClient
      .rpush("query", query)
      .then(() => {
        redisClient.incr("queued_count");
      })
      .then(() => {
        console.log("Report enqueued :", query);
        return res.render("report", {
          openRedirectSuccess: "OK. Admin will check the URL you sent.",
          openRedirectError: "",
          csrfSuccess: "",
          csrfError: ""
        });
      });
  } catch (e) {
    console.log("Report error :", e);
    return res.render("report", {
      openRedirectSuccess: "",
      openRedirectError: "Internal error",
      csrfSuccess: "",
      csrfError: ""
    });
  }
});

app.post("/report/csrf", async (req, res, next) => {
  // Parameter check
  const { path } = req.body;
  if (!path || path === "") {
    return res.render("report", {
      openRedirectSuccess: "",
      openRedirectError: "",
      csrfSuccess: "",
      csrfError: "invalid parameter"
    });
  }
  let query = {"type": "csrf", "path": path};
  query = JSON.stringify(query);

  try {
    // Enqueued jobs are processed by crawl.js
    redisClient
      .rpush("query", query)
      .then(() => {
        redisClient.incr("queued_count");
      })
      .then(() => {
        console.log("Report enqueued :", query);
        return res.render("report", {
          openRedirectSuccess: "",
          openRedirectError: "",
          csrfSuccess: "OK. Admin will check the URL you sent.",
          csrfError: ""
        });
      });
  } catch (e) {
    console.log("Report error :", e);
    return res.render("report", {
      openRedirectSuccess: "",
      openRedirectError: "",
      csrfSuccess: "",
      csrfError: "Internal error"
    });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`OAuth server listening at http://${HOST}:${PORT}`);
});