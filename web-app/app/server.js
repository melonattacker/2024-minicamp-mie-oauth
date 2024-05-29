const express = require('express');
const session = require('express-session');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const htmlValidator = require('html-validator');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// セッションの設定
app.use(session({
  secret: crypto.randomBytes(64).toString('hex'),
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

const jwtSecret = crypto.randomBytes(64).toString('hex');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const users = {
  admin: { password: ADMIN_PASSWORD, isAdmin: true, amount: 100000000000000 },
  guest: { password: 'guest', isAdmin: false, amount: 100 },
};

// ホーム画面
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// トークンの検証機能
const verifyToken = (req, res, next) => {
  // Authorization ヘッダーからトークンを取得
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    // トークンの検証
    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded;
    next();
  }
  catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ユーザー登録機能
app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.post('/signup', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (users[username]) {
    return res.status(400).json({ error: 'User already exists' });
  }

  users[username] = { password, isAdmin: false, amount: 100 };
  res.status(201).json({ message: 'User registered successfully' });
});

// ログイン機能
app.get('/signin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signin.html'));
});

app.post('/signin', (req, res) => {
  const { username, password } = req.body;
  const user = users[username];

  if (user && user.password === password) {
    const token = jwt.sign({ username, isAdmin: user.isAdmin }, jwtSecret, { expiresIn: '1h' });
    res.status(200).json({ token });
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
});

// 送金機能
app.get('/transfer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'transfer.html'));
});

app.post('/transfer', verifyToken, (req, res) => {
  let { dest, amount } = req.body;
  const user = users[req.user.username];

  if (!dest || !amount) {
    return res.status(400).json({ error: 'Destination user and amount are required' });
  }

  amount = parseInt(amount);

  if (isNaN(amount) || user.amount < amount || amount <= 0 || amount > 1000000) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  if (!users[dest] || dest === req.user.username) {
    return res.status(400).json({ error: 'invalid destination user' });
  }


  user.amount -= amount;
  users[dest].amount += amount;
  res.status(200).json({ message: 'Transfer successful' });
});

// ユーザー情報取得機能
app.get('/user/:username', (req, res) => {
  const user = users[req.params.username];
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.status(200).json({ username: req.params.username, amount: user.amount });
});

// 自身のユーザー情報取得機能
app.get('/me', verifyToken, (req, res) => {
  const user = users[req.user.username];
  res.status(200).json({ username: req.user.username, amount: user.amount });
});

// ユーザー一覧取得機能
app.get('/users', (req, res) => {
  const userList = Object.keys(users).map(username => ({ username, amount: users[username].amount }));
  res.status(200).json({ users: userList });
});

// レポート機能
// Redis
const Redis = require("ioredis");
let redisClient = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
});
redisClient.set("queued_count", 0);
redisClient.set("proceeded_count", 0);

app.get("/report", async (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'report.html'));
});

app.post("/report/open-redirect", async (req, res, next) => {
  // Parameter check
  const { path } = req.body;
  if (!path || path === "") {
    res.status(400).json({ error: 'Invalid request' });
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
        console.log("Report enqueued :", path);
        res.status(200).json({ message: 'OK. Admin will check the URL you sent.' });
      });
  } catch (e) {
    console.log("Report error :", e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post("/report/csrf", async (req, res, next) => {
  // Parameter check
  const { html } = req.body;
  if (!html || html === "") {
    res.status(400).json({ error: 'Invalid request' });
  }
  let query = {"type": "csrf", "html": html};
  query = JSON.stringify(query);
  try {
    // validate HTML content
    const validationResults = await htmlValidator({ data: html, isFragment: true });
    console.log(validationResults);

    if (validationResults.messages && validationResults.messages.length > 0) {
      return res.status(400).json({ error: 'Invalid HTML content' });
    }

    // Enqueued jobs are processed by crawl.js
    redisClient
      .rpush("query", query)
      .then(() => {
        redisClient.incr("queued_count");
      })
      .then(() => {
        console.log("Report enqueued :", path);
        res.status(200).json({ message: 'OK. Admin will check the URL you sent.' });
      });
  } catch (e) {
    console.log("Report error :", e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

const PORT = process.env.PORT || 22355;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
