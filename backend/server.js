const mqtt = require('mqtt');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fetch = require('node-fetch'); // Importera node-fetch
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());

// Begränsa inloggningsförsök (max 5 per 15 minuter per IP)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'För många inloggningsförsök, försök igen senare.' }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';

const initDb = async (delayMs = 2000) => {
  const createSql = `
    CREATE TABLE IF NOT EXISTS positions (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP WITH TIME ZONE,
      lat FLOAT,
      lng FLOAT,
      raw_data JSONB
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE,
      password_hash TEXT
    );
  `;

  while (true) {
    try {
      await pool.query(createSql);

      // Skapa användare från .env om de inte finns
      const initialUsers = [[process.env.ADMIN_USER || 'admin', process.env.ADMIN_PASS || 'mc-pass']];
      
      // Lägg till extra användare från formatet "user1:pass1,user2:pass2"
      if (process.env.EXTRA_USERS) {
        process.env.EXTRA_USERS.split(',').forEach(pair => {
          initialUsers.push(pair.split(':'));
        });
      }

      for (const [username, password] of initialUsers) {
        const userExists = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (userExists.rows.length === 0) {
          const hash = await bcrypt.hash(password, 10);
          await pool.query('INSERT INTO users (username, password_hash) VALUES ($1, $2)', [username, hash]);
          console.log(`Användare skapad vid init: ${username}`);
        }
      }

      console.log('Database ready and table ensured');
      return;
    } catch (err) {
      console.log(`Database not ready, retrying in ${delayMs}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
};
initDb();

const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Saknar token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user_id = decoded.id;
    next();
  } catch { res.status(401).json({ error: 'Ogiltig token' }); }
};

// In-memory state för att spåra aktiva händelser per enhet och undvika dubbla aviseringar
const deviceEventStates = {}; // Format: { 'topic': { '247': 0, '248': 0 } }

const sendNotification = async (eventType, topic, reportedData) => {
  const HOME_ASSISTANT_WEBHOOK_URL = process.env.HOME_ASSISTANT_WEBHOOK_URL;
  const TEXTBEE_API_KEY = process.env.TEXTBEE_API_KEY;
  const TEXTBEE_CHANNEL_ID = process.env.TEXTBEE_CHANNEL_ID;

  const message = `MC Tracker Alert: ${eventType.toUpperCase()} detected on ${topic} at ${new Date(reportedData.ts).toLocaleString()}! Lat: ${reportedData.latlng.split(',')[0]}, Lng: ${reportedData.latlng.split(',')[1]}`;

  // Home Assistant Webhook
  if (HOME_ASSISTANT_WEBHOOK_URL) {
    try {
      await fetch(HOME_ASSISTANT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type: `mc_tracker_${eventType}_alert`,
          data: {
            topic: topic,
            event: eventType,
            timestamp: reportedData.ts,
            latitude: reportedData.latlng.split(',')[0],
            longitude: reportedData.latlng.split(',')[1],
            message: message
          }
        })
      });
      console.log(`[Notification] Home Assistant webhook skickad för ${eventType}.`);
    } catch (error) {
      console.error(`[Notification] Misslyckades skicka Home Assistant webhook för ${eventType}:`, error.message);
    }
  }

  // Textbee.dev Notification
  if (TEXTBEE_API_KEY && TEXTBEE_CHANNEL_ID) {
    try {
      await fetch(`https://textbee.dev/api/v1/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': TEXTBEE_API_KEY
        },
        body: JSON.stringify({
          channel_id: TEXTBEE_CHANNEL_ID,
          message: message,
          title: `MC Tracker ${eventType.toUpperCase()}!`,
          priority: 1 // Hög prioritet
        })
      });
      console.log(`[Notification] Textbee.dev avisering skickad för ${eventType}.`);
    } catch (error) {
      console.error(`[Notification] Misslyckades skicka Textbee.dev avisering för ${eventType}:`, error.message);
    }
  }
};

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

    // --- Händelsedetektering för aviseringar ---
    const crashDetection = reported['247']; // Antar att 247 är I/O-ID för Crash Detection
    const towingDetection = reported['248']; // Antar att 248 är I/O-ID för Towing Detection

    // Initiera tillstånd för denna topic om det inte finns
    if (!deviceEventStates[topic]) {
      deviceEventStates[topic] = { '247': 0, '248': 0 };
    }

    // Kontrollera Crash Detection
    if (crashDetection === 1 && deviceEventStates[topic]['247'] !== 1) {
      console.log(`[Event] Crash Detected för ${topic}!`);
      sendNotification('crash', topic, reported);
      deviceEventStates[topic]['247'] = 1; // Uppdatera tillstånd
    } else if (crashDetection === 0 && deviceEventStates[topic]['247'] === 1) {
      deviceEventStates[topic]['247'] = 0; // Återställ tillstånd när händelsen upphör
    }

    // Kontrollera Towing Detection
    if (towingDetection === 1 && deviceEventStates[topic]['248'] !== 1) {
      console.log(`[Event] Towing Detected för ${topic}!`);
      sendNotification('towing', topic, reported);
      deviceEventStates[topic]['248'] = 1; // Uppdatera tillstånd
    } else if (towingDetection === 0 && deviceEventStates[topic]['248'] === 1) {
      deviceEventStates[topic]['248'] = 0; // Återställ tillstånd när händelsen upphör
    }
    // --- Slut på händelsedetektering ---

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

app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Fel användarnamn eller lösenord' });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (isMatch) {
      const token = jwt.sign({ user: user.username, id: user.id }, JWT_SECRET, { expiresIn: '24h' });
      return res.json({ token });
    }
    res.status(401).json({ error: 'Fel användarnamn eller lösenord' });
  } catch (err) {
    res.status(500).json({ error: 'Serverfel vid inloggning' });
  }
});

app.post('/api/update-password', authenticate, async (req, res) => {
  const { newPassword } = req.body;
  const userId = req.user_id; // Vi behöver uppdatera authenticate för att sätta detta
  try {
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);
    res.json({ message: 'Lösenordet har uppdaterats' });
  } catch (err) {
    res.status(500).json({ error: 'Kunde inte uppdatera lösenordet' });
  }
});

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

app.get('/api/stats/distance', authenticate, async (req, res) => {
  const { days } = req.query;
  const query = `SELECT SUM(dist) as total_distance FROM (SELECT ST_DistanceSphere(ST_MakePoint(lng, lat), LAG(ST_MakePoint(lng, lat)) OVER (ORDER BY ts)) as dist FROM positions WHERE ts > NOW() - interval '${days} days') sub;`;
  const result = await pool.query(query);
  res.json(result.rows[0]);
});

server.listen(3001, () => console.log('Backend körs på port 3001'));