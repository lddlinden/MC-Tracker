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

mqttClient.on('error', (err) => {
  console.error('[MQTT] Anslutningsfel:', err.message);
});

mqttClient.on('reconnect', () => {
  console.log('[MQTT] Försöker ansluta igen...');
});

mqttClient.on('connect', () => {
  mqttClient.subscribe('teltonika/fmc880');
  console.log('[MQTT] Ansluten! Prenumererar på: teltonika/fmc880');
});

mqttClient.on('message', async (topic, message) => {
  const rawPayload = message.toString();
  console.log(`[MQTT] Nytt råmeddelande på ${topic}: ${rawPayload}`);

  try {
    const data = JSON.parse(rawPayload);

    // Försök hitta positionen i JSON-strukturen
    // Vi kollar både efter 'state.reported' (AWS format) och direkt i roten (Teltonika/Generic format)
    const reported = data.state?.reported || data; 
    
    if (!reported || !reported.latlng) {
      console.error("[Parser] Fel: Hittade ingen 'latlng' (t.ex. \"56.8,14.8\") i JSON-objektet");
      return;
    }

    const [lat, lng] = reported.latlng.split(',').map(Number);
    
    // Hantera både numeriska timestamps och strängar
    const timestampValue = reported.ts;
    const tsDate = new Date(timestampValue);
    if (isNaN(tsDate.getTime())) {
      console.error("[Parser] Fel: Ogiltig timestamp:", timestampValue);
      return;
    }

    try {
      await pool.query(
        'INSERT INTO positions (ts, lat, lng, raw_data) VALUES ($1, $2, $3, $4)',
        [tsDate, lat, lng, data]
      );
      console.log(`Position sparad: ${lat}, ${lng} (Tid: ${tsDate.toISOString()})`);
      io.emit('position-update', { ts: tsDate.toISOString(), lat, lng, raw_data: data });
    } catch (dbErr) {
      console.error("[Database] Fel vid INSERT:", dbErr.message);
    }

  } catch (err) {
    console.error("KRITISKT FEL i MQTT-hanterare:", err.message);
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
  // Lägg till tid för att inkludera hela slutdagen (t.ex. 2026-05-28 23:59:59)
  const adjustedEnd = end.includes('T') ? end : `${end} 23:59:59`;
  const result = await pool.query(
    'SELECT * FROM positions WHERE ts BETWEEN $1 AND $2 ORDER BY ts ASC',
    [start, adjustedEnd]
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