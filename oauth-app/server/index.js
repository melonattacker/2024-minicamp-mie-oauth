const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const logger = require("morgan");
const { v4: uuidv4 } = require("uuid");

const HOST = process.env.HOST;
const PORT = process.env.PORT;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";
const FLAG = process.env.FLAG;

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
    password: ADMIN_PASSWORD
  },
  {
    user_id: uuidv4(),
    username: "guest",
    password: "guest"
  },
];
const clients = [
  {
    client_id: "oauth-client",
    client_secret: CLIENT_SECRET,
    redirect_uris: [`${CLIENT_URL}/callback`],
    scopes: ["email", "profile"]
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
    username: user.username,
    access_token: access_token.value,
    token_type: "Bearer",
    expires_in: 3600,
    scopes: access_token.scopes
  });
});

app.get("/report", async (req, res, next) => {
  res.render("report", {
    openRedirectSuccess: "",
    openRedirectError: ""
  });
});

app.post("/report/open-redirect", async (req, res, next) => {
  // Parameter check
  const { path } = req.body;
  if (!path || path === "") {
    return res.render("report", {
      openRedirectSuccess: "",
      openRedirectError: "invalid parameter"
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
          openRedirectError: ""
        });
      });
  } catch (e) {
    console.log("Report error :", e);
    return res.render("report", {
      openRedirectSuccess: "",
      openRedirectError: "Internal error"
    });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`OAuth server listening at http://${HOST}:${PORT}`);
});