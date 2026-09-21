import net from 'node:net';

const ports = [15432, 15433, 5173, 5433, 6543, 8080, 8787, 18080];

function tryBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.on('error', (error) => resolve(`port ${port}: ERR ${error.code}`));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(`port ${port}: BIND_OK`));
    });
  });
}

for (const port of ports) {
  console.log(await tryBind(port));
}
