const mqtt = require('mqtt');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';

const initDb = async (delayMs = 3000) => {
  const createSql = `
    CREATE TABLE IF NOT EXISTS positions (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP WITH TIME ZONE,
      lat FLOAT,
      lng FLOAT,
      raw_data JSONB
    );
  `;

  while (true) {
    try {
      await pool.query(createSql);
      console.log('Database ready and table ensured');
      return;
    } catch (err) {
      console.log(`Database not ready, retrying in ${delayMs}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
};
initDb();

const mqttClient = mqtt.connect(process.env.MQTT_URL || 'mqtt://mqtt:1883');

mqttClient.on('connect', () => {
  mqttClient.subscribe('tracker/data');
});

mqttClient.on('message', async (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    const reported = data.state.reported;
    const [lat, lng] = reported.latlng.split(',').map(Number);
    const ts = new Date(reported.ts).toISOString();

    await pool.query(
      'INSERT INTO positions (ts, lat, lng, raw_data) VALUES (to_timestamp($1/1000.0), $2, $3, $4)',
      [reported.ts, lat, lng, data]
    );

    io.emit('position-update', { ts, lat, lng, raw_data: data });
    console.log("Position sparad:", lat, lng);
  } catch (err) {
    console.error("Fel vid lagring av MQTT data:", err);
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'mc-pass') {
    const token = jwt.sign({ user: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Fel användarnamn eller lösenord' });
});

const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Saknar token' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Ogiltig token' }); }
};

app.get('/api/history', authenticate, async (req, res) => {
  const { start, end } = req.query;
  const result = await pool.query(
    'SELECT * FROM positions WHERE ts BETWEEN $1 AND $2 ORDER BY ts ASC',
    [start, end]
  );
  res.json(result.rows);
});

app.get('/api/stats/distance', async (req, res) => {
  const { days } = req.query;
  const query = `SELECT SUM(dist) as total_distance FROM (SELECT ST_DistanceSphere(ST_MakePoint(lng, lat), LAG(ST_MakePoint(lng, lat)) OVER (ORDER BY ts)) as dist FROM positions WHERE ts > NOW() - interval '${days} days') sub;`;
  const result = await pool.query(query);
  res.json(result.rows[0]);
});

server.listen(3001, () => console.log('Backend körs på port 3001'));