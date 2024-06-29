const { chromium } = require('playwright');
const { v4: uuidv4 } = require("uuid");
const Redis = require("ioredis");
const connection = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
});

const ADMIN_USERNAME = process.env.ADMIN_USERNAME; 
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; 
const APP_URL = process.env.APP_URL;

const crawlOpenRedirect = async (path, ID) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    // (If you set `signin?next=/` as path in Report page, admin accesses `http://localhost:22355/signin?next=/` here.)
    const targetURL = APP_URL + path;
    console.log("target url:", targetURL);
    await page.goto(targetURL, {
        waitUntil: "domcontentloaded",
        timeout: 1000, 
    }); 
    await page.waitForSelector("input[id=username]", { timeout: 1000 });
    await page.type("input[id=username]", ADMIN_USERNAME);
    await page.type("input[id=password]", ADMIN_PASSWORD);
    await page.click("button[type=submit]");

    await page.waitForTimeout(1000);

    await page.close();
  } catch (err) {
    console.error("crawl", ID, err.message);
  } finally {
    await browser.close();
    console.log("crawl", ID, "browser closed");
  }
};

const crawlCSRF = async (html, ID) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const loginURL = APP_URL + 'signin';
    console.log("login url:", loginURL);
    await page.goto(loginURL, {
      waitUntil: "domcontentloaded",
      timeout: 1000,
    });
    await page.waitForSelector("input[id=username]", { timeout: 1000 });
    await page.type("input[id=username]", ADMIN_USERNAME);
    await page.type("input[id=password]", ADMIN_PASSWORD);
    await page.click("button[type=submit]");

    await page.waitForNavigation({ waitUntil: 'domcontentloaded' });

    console.log("logged in as admin");
    
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    console.log("HTML content set");

    await page.waitForTimeout(1000);
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
          const html = query.html;
          return crawlCSRF(html, ID);
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