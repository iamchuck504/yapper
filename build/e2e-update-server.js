// Serves one directory as an electron-updater generic feed, for the update E2E.
const fs = require('fs');
const path = require('path');
const http = require('http');

const dir = process.argv[2];
const served = [];

http.createServer((req, res) => {
  // electron-updater appends ?noCache=… — the file name is the path alone
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\//, ''));
  const file = path.join(dir, name);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    console.log(`404 ${req.url}`);
    res.writeHead(404);
    return res.end();
  }
  served.push(req.url);
  console.log(`served ${req.url}`);
  res.writeHead(200, { 'content-length': fs.statSync(file).size });
  res.on('finish', () => console.log(`completed ${req.url}`));
  fs.createReadStream(file).pipe(res);
}).listen(8123, '127.0.0.1', () => console.log(`feed on 8123 from ${dir}`));
