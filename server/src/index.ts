import 'dotenv/config';
import http from 'node:http';
import express from 'express';

const PORT = Number(process.env.PORT ?? 8080);

const app = express();
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, lastRefreshAt: null, staticLoadedAt: null });
});

const httpServer = http.createServer(app);

httpServer.listen(PORT, () => {
  console.log(`dispatch listening on :${PORT}`);
});
