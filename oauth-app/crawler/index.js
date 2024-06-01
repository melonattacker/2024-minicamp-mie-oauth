const { chromium } = require("playwright");
const { v4: uuidv4 } = require("uuid");
const Redis = require("ioredis");
const connection = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
});

const USERNAME = process.env.USERNAME; // admin username
const PASSWORD = process.env.PASSWORD; // admin password
const SERVER_URL = process.env.SERVER_URL;

const crawlOpenRedirect = async (path, ID) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const targetURL = SERVER_URL + path;
    console.log("target url:", targetURL);
    await page.goto(targetURL, {
        waitUntil: "domcontentloaded",
        timeout: 3000, 
    }); 
    await page.waitForSelector("input[name=username]");
    await page.type("input[name=username]", USERNAME);
    await page.type("input[name=password]", PASSWORD);
    await page.click("input[name=approved]");

    await page.waitForTimeout(1000);

    await page.close();
  } catch (err) {
    console.error("crawl", ID, err.message);
  } finally {
    await browser.close();
    console.log("crawl", ID, "browser closed");
  }
};

(async () => {
  while (true) {
    console.log(
      "[*] waiting new query",
      await connection.get("queued_count"),
      await connection.get("proceeded_count")
    );
    const ID = uuidv4();
    await connection
      .blpop("query", 0)
      .then((v) => {
        const query = JSON.parse(v[1]);
        console.log("crawl", ID, query);
        const type = query.type;

        if(type === "open-redirect") {
          const path = query.path;
          return crawlOpenRedirect(path, ID);
        } else if(type == "csrf") {
          // const html = query.html;
          // return crawlCSRF(html, ID);
        }
      })
      .then(() => {
        console.log("crawl", ID, "finished");
        return connection.incr("proceeded_count");
      })
      .catch((e) => {
        console.log("crawl", ID, e);
      });
  }
})();