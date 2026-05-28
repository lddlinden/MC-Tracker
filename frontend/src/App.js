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

  const [startDate, setStartDate] = useState(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState(new Date().toISOString().split('T')[0]);

  const [visibleFields, setVisibleFields] = useState(['66', '67', '239', '240', 'sp']);

  const fieldLabels = {
    '66': 'MC Batteri (V)',
    '67': 'Internt Batteri (V)',
    '239': 'Tändning',
    '240': 'Rörelse',
    'sp': 'Hastighet (km/h)',
    'sat': 'Satelliter',
    'alt': 'Höjd (m)',
    '241': 'GSM Signal'
  };

  const formatValue = (key, val) => {
    if (key === '66' || key === '67') return (val / 1000).toFixed(2) + ' V';
    if (key === '239' || key === '240') return val === 1 ? 'JA' : 'NEJ';
    return val;
  };

  // Login handler (can be used in login form)
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

  // EFFECTS: Hooks must be called unconditionally — guard inside each effect
  useEffect(() => {
    if (!token) return;
    fetch(`/api/history?start=${startDate}&end=${endDate}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        if (Array.isArray(data)) {
          setPositions(data);
          if (data.length > 0) setSelectedPoint(data[data.length - 1]);
        } else {
          console.error('History data is not an array:', data);
          setPositions([]);
        }
      })
      .catch(err => console.error('Failed to fetch history:', err));
  }, [token, startDate, endDate]);

  useEffect(() => {
    fetch('/api/stats/distance?days=7')
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => setStats(data || { total_distance: 0 }))
      .catch(err => console.error('Failed to fetch stats:', err));
  }, []);

  // Socket.io listener for realtime updates
  useEffect(() => {
    const socket = io(window.location.origin, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5
    });

    socket.on('connect', () => console.log('Socket.io connected'));
    socket.on('connect_error', (error) => console.error('Socket.io connection error:', error));

    socket.on('position-update', (newPos) => {
      setPositions(prev => [...prev, newPos]);
      setSelectedPoint(newPos);
    });

    return () => socket.disconnect();
  }, []);

  const polylineCoords = positions.map(p => [p.lat, p.lng]);
  const latestPos = positions.length > 0 ? [positions[positions.length - 1].lat, positions[positions.length - 1].lng] : [56.8, 14.8];

  const handleLogout = () => {
    localStorage.removeItem('mc_token');
    setToken(null);
  };

  if (!token) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', fontFamily: 'Inter, system-ui, sans-serif', backgroundColor: '#f4f4f9' }}>
        <div style={{ background: '#fff', padding: '40px', borderRadius: '10px', boxShadow: '0 4px 20px rgba(0,0,0,0.1)', width: '100%', maxWidth: '400px' }}>
          <h1 style={{ fontSize: '1.8rem', marginBottom: '30px', textAlign: 'center', color: '#1a1a2e' }}>🏍️ MC-NAV</h1>
          <form onSubmit={handleLogin}>
            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600', color: '#1a1a2e' }}>
                Användarnamn
              </label>
              <input
                type="text"
                name="user"
                placeholder="admin"
                required
                style={{
                  width: '100%',
                  padding: '12px',
                  border: '2px solid #e0e0e0',
                  borderRadius: '6px',
                  fontSize: '1rem',
                  boxSizing: 'border-box',
                  fontFamily: 'inherit'
                }}
              />
            </div>
            <div style={{ marginBottom: '30px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600', color: '#1a1a2e' }}>
                Lösenord
              </label>
              <input
                type="password"
                name="pass"
                placeholder="••••••••"
                required
                style={{
                  width: '100%',
                  padding: '12px',
                  border: '2px solid #e0e0e0',
                  borderRadius: '6px',
                  fontSize: '1rem',
                  boxSizing: 'border-box',
                  fontFamily: 'inherit'
                }}
              />
            </div>
            <button
              type="submit"
              style={{
                width: '100%',
                padding: '12px',
                background: '#0f3460',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                fontSize: '1rem',
                fontWeight: '600',
                cursor: 'pointer',
                transition: 'background 0.3s ease'
              }}
              onMouseEnter={(e) => e.target.style.background = '#16213e'}
              onMouseLeave={(e) => e.target.style.background = '#0f3460'}
            >
              Logga in
            </button>
          </form>
          <p style={{ marginTop: '20px', fontSize: '0.9rem', color: '#666', textAlign: 'center' }}>
            Demo: admin / mc-pass
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'Inter, system-ui, sans-serif', backgroundColor: '#f4f4f9' }}>
      {/* Sidebar för statistik och JSON-data */}
      <div style={{ width: '400px', backgroundColor: '#1a1a2e', color: '#fff', padding: '20px', overflowY: 'auto', boxShadow: '4px 0 10px rgba(0,0,0,0.1)', zIndex: 1000 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', paddingBottom: '10px', borderBottom: '1px solid #30304d' }}>
          <h1 style={{ fontSize: '1.5rem', margin: 0 }}>🏍️ MC-NAV Dashboard</h1>
          <button
            onClick={handleLogout}
            style={{
              background: '#e63946',
              color: '#fff',
              border: 'none',
              padding: '8px 12px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '0.9rem',
              fontWeight: '600'
            }}
            onMouseEnter={(e) => e.target.style.background = '#d62828'}
            onMouseLeave={(e) => e.target.style.background = '#e63946'}
          >
            Logga ut
          </button>
        </div>
        
        {/* Statistik-kort */}
        <div style={{ display: 'grid', gap: '15px', marginBottom: '30px' }}>
          <div style={{ background: '#16213e', padding: '15px', borderRadius: '10px' }}>
            <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>DISTANS (7 DAGAR)</span>
            <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>{(stats.total_distance / 1000).toFixed(2)} km</div>
          </div>
        </div>

        {/* Filter-sektion */}
        <div style={{ background: '#16213e', padding: '15px', borderRadius: '10px', marginBottom: '20px' }}>
          <h3 style={{ fontSize: '0.9rem', color: '#94a3b8', marginTop: 0 }}>FILTRERA HISTORIK</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ padding: '5px', borderRadius: '4px', border: 'none' }} />
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={{ padding: '5px', borderRadius: '4px', border: 'none' }} />
          </div>
          
          <h3 style={{ fontSize: '0.9rem', color: '#94a3b8', marginTop: '15px' }}>VISA DATA</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', fontSize: '0.8rem' }}>
            {Object.keys(fieldLabels).map(key => (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                <input type="checkbox" checked={visibleFields.includes(key)} 
                  onChange={() => setVisibleFields(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key])} 
                /> {fieldLabels[key]}
              </label>
            ))}
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
                {visibleFields.map(key => (
                  <div key={key}>
                    {fieldLabels[key] || key}: {formatValue(key, selectedPoint.raw_data.state?.reported[key] || selectedPoint[key])}
                  </div>
                ))}
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
