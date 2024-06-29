const path = require("path");
const express = require("express");
const session = require("express-session");
const crypto = require("crypto");
const logger = require("morgan");
const axios = require("axios");

const HOST = process.env.HOST;
const PORT = process.env.PORT;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";
const SERVER_URL = process.env.SERVER_URL || "http://localhost:3001";
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

const app = express();
app.use(logger("common"));

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

// Session
app.use(session({
  name: "client-session",
  secret: crypto.randomBytes(16).toString("hex"),
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

app.get("/", (req, res) => {
  res.render("index", { 
    username: req.session.username, 
    scopes: req.session.scopes,
    images: []
  });
});

app.get("/auth", (req, res) => {
  // Generate and store state parameter
  const state = crypto.randomBytes(16).toString("hex");
  req.session.state = state;

  // Send Authorization Request
  console.log("SERVER_URL:", SERVER_URL);
  const authUrl = new URL(`${SERVER_URL}/auth`);

  authUrl.searchParams.append("response_type", "code"); // Use Authrozation Code Grant
  authUrl.searchParams.append("client_id", CLIENT_ID);
  authUrl.searchParams.append("redirect_uri", `${CLIENT_URL}/callback`);
  authUrl.searchParams.append("scopes", "image profile");
  authUrl.searchParams.append("state", state);

  res.redirect(authUrl.href);
});

app.get("/callback", async(req, res) => {
  if (req.query.error) {
    res.render("error", { error: req.query.error, error_description: req.query.error_description });
    return;
  }

  // TODO: Verify state parameter
  // if (req.query.state !== req.session.state) {
  //   res.render("error", { error: "Invalid state parameter", error_description: "State parameter does not match" });
  //   return;
  // }

  // Clear state parameter from session
  delete req.session.state;

  // Send Access Token Request
  const params = req.query;
  params.grant_type = "authorization_code";
  params.redirect_uri = `${CLIENT_URL}/callback`;
  const tokenUrl = "http://server:3001/token";
  const imageUrl = "http://server:3001/images";

  try {
    const tokenResponse = await axios.post(tokenUrl, params, {
      headers: { 
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64")
      }
    });
    req.session.access_token = tokenResponse.data.access_token;
    req.session.scopes = tokenResponse.data.scopes;

    const imageResponse = await axios.get(imageUrl, {
      headers: { 
        "Authorization": "Bearer " + req.session.access_token
      }
    });

    req.session.username = imageResponse.data.username;

    res.render("index", { 
      username: req.session.username, 
      scopes: req.session.scopes,
      images: imageResponse.data.images
    });
    return;
    
  } catch(err) {
    res.render("error", { 
      error: err.response.data.error, 
      error_description: err.response.data.error_description 
    });
    return;
  }
});

app.post("/logout", async(req, res) => {
  req.session.destroy();
  res.redirect("/");
});


app.listen(PORT, HOST, () => {
  console.log(`OAuth client listening at http://${HOST}:${PORT}`);
});
