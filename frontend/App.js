import React, { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { io } from 'socket.io-client';

// Fix för standardikoner i Leaflet när man kör via Webpack/React
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// Hjälpkomponent för att centrera kartan när ny data kommer in
function RecenterMap({ coords }) {
  const map = useMap();
  useEffect(() => {
    if (coords) map.setView(coords, map.getZoom());
  }, [coords, map]);
  return null;
}

function App() {
  const [token, setToken] = useState(localStorage.getItem('mc_token'));
  const [positions, setPositions] = useState([]);
  const [stats, setStats] = useState({ total_distance: 0 });
  const [selectedPoint, setSelectedPoint] = useState(null);

  const handleLogin = async (e) => {
    e.preventDefault();
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: e.target.user.value, password: e.target.pass.value })
    });
    const data = await res.json();
    if (data.token) {
      localStorage.setItem('mc_token', data.token);
      setToken(data.token);
    } else { alert('Fel inloggning'); }
  };

  if (!token) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: '#1a1a2e' }}>
        <form onSubmit={handleLogin} style={{ background: '#fff', padding: '40px', borderRadius: '10px', display: 'flex', flexDirection: 'column', gap: '15px' }}>
          <h2>MC-NAV Login</h2>
          <input name="user" placeholder="Användarnamn" style={{ padding: '10px' }} />
          <input name="pass" type="password" placeholder="Lösenord" style={{ padding: '10px' }} />
          <button type="submit" style={{ padding: '10px', background: '#0f3460', color: '#fff', border: 'none', cursor: 'pointer' }}>Logga in</button>
        </form>
      </div>
    );
  }

  useEffect(() => {
    fetch('/api/history?start=2023-01-01&end=2025-01-01', { headers: { Authorization: `Bearer ${token}` } })
      .then(res => {
        if (!res.ok) {
          if (res.status === 401) {
            localStorage.removeItem('mc_token');
            setToken(null);
            throw new Error('Token expired or invalid');
          }
          throw new Error(`API error: ${res.status}`);
        }
        return res.json();
      })
      .then(data => {
        if (Array.isArray(data)) {
          setPositions(data);
          if (data.length > 0) setSelectedPoint(data[data.length - 1]);
        } else {
          setPositions([]);
        }
      })
      .catch(err => {
        console.error('Failed to load history:', err);
        setPositions([]);
      });

    fetch('/api/stats/distance?days=7')
      .then(res => {
        if (!res.ok) throw new Error(`Stats API error: ${res.status}`);
        return res.json();
      })
      .then(data => {
        if (data && typeof data === 'object') {
          setStats(data);
        }
      })
      .catch(err => console.error('Failed to load stats:', err));
  }, [token]);

  // Socket.io lyssnare för realtidsuppdateringar
  useEffect(() => {
    const socket = io(window.location.origin);

    socket.on('position-update', (newPos) => {
      setPositions(prev => [...prev, newPos]);
      setSelectedPoint(newPos);
    });

    return () => socket.disconnect();
  }, []);

  const polylineCoords = positions.map(p => [p.lat, p.lng]);
  const latestPos = positions.length > 0 ? [positions[positions.length - 1].lat, positions[positions.length - 1].lng] : [56.8, 14.8];

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'Inter, system-ui, sans-serif', backgroundColor: '#f4f4f9' }}>
      {/* Sidebar för statistik och JSON-data */}
      <div style={{ width: '400px', backgroundColor: '#1a1a2e', color: '#fff', padding: '20px', overflowY: 'auto', boxShadow: '4px 0 10px rgba(0,0,0,0.1)', zIndex: 1000 }}>
        <h1 style={{ fontSize: '1.5rem', marginBottom: '20px', borderBottom: '1px solid #30304d', paddingBottom: '10px' }}>🏍️ MC-NAV Dashboard</h1>
        
        {/* Statistik-kort */}
        <div style={{ display: 'grid', gap: '15px', marginBottom: '30px' }}>
          <div style={{ background: '#16213e', padding: '15px', borderRadius: '10px' }}>
            <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>DISTANS (7 DAGAR)</span>
            <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>{(stats.total_distance / 1000).toFixed(2)} km</div>
          </div>
        </div>

        {/* JSON Telemetri-vy */}
        {selectedPoint ? (
          <div>
            <h3 style={{ fontSize: '1rem', color: '#94a3b8', marginBottom: '10px' }}>LIVE TELEMETRI</h3>
            <div style={{ background: '#0f3460', padding: '15px', borderRadius: '10px', fontSize: '0.85rem' }}>
              <div style={{ marginBottom: '10px', color: '#4cc9f0' }}>
                <strong>Tidpunkt:</strong> {new Date(selectedPoint.ts).toLocaleString('sv-SE')}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div>📍 Lat: {selectedPoint.lat.toFixed(4)}</div>
                <div>📍 Lng: {selectedPoint.lng.toFixed(4)}</div>
                <div>🚀 Hastighet: {selectedPoint.raw_data.state.reported.sp} km/h</div>
                <div>⛰️ Höjd: {selectedPoint.raw_data.state.reported.alt} m</div>
                <div>🛰️ Satelliter: {selectedPoint.raw_data.state.reported.sat}</div>
                <div>🔋 Event: {selectedPoint.raw_data.state.reported.evt}</div>
              </div>
              
              <h4 style={{ marginTop: '20px', color: '#94a3b8', fontSize: '0.8rem' }}>RÅDATA (JSON)</h4>
              <pre style={{ 
                fontSize: '0.75rem', 
                backgroundColor: '#1a1a2e', 
                padding: '10px', 
                borderRadius: '5px', 
                overflowX: 'auto',
                border: '1px solid #30304d'
              }}>
                {JSON.stringify(selectedPoint.raw_data, null, 2)}
              </pre>
            </div>
          </div>
        ) : (
          <p>Laddar data...</p>
        )}
      </div>

      {/* Kartvy */}
      <div style={{ flexGrow: 1, position: 'relative' }}>
        <MapContainer center={latestPos} zoom={13} style={{ height: '100%', width: '100%' }}>
          <TileLayer 
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" 
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          />
          <RecenterMap coords={latestPos} />
          
          {/* Rita ut spåret */}
          {polylineCoords.length > 0 && <Polyline positions={polylineCoords} color="#4cc9f0" weight={4} opacity={0.7} />}
          
          {/* Senaste position-markör */}
        {polylineCoords.length > 0 && (
          <Marker position={latestPos}>
            <Popup>
              <strong>Senaste position</strong><br />
              {new Date(selectedPoint?.ts).toLocaleTimeString()}
            </Popup>
          </Marker>
        )}
        </MapContainer>
      </div>
    </div>
  );
}

export default App;