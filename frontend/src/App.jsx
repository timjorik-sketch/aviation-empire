import { useState, useEffect } from 'react'
import axios from 'axios'
import './App.css'

function App() {
  const [apiStatus, setApiStatus] = useState('Checking...')
  const [apiMessage, setApiMessage] = useState('')

  useEffect(() => {
    axios.get('https://glorious-lamp-jjvxpgvv9gj4c57vg-3001.app.github.dev/')
      .then(response => {
        setApiStatus('✅ Connected')
        setApiMessage(response.data.message)
      })
      .catch(error => {
        setApiStatus('❌ Offline')
        setApiMessage('Backend nicht erreichbar')
      })
  }, [])

  return (
    <div className="app">
      <div className="container">
        <div className="header">
          <h1>✈️ Aviation Empire</h1>
          <p className="subtitle">Multiplayer Airline Simulation</p>
        </div>

        <div className="status-card">
          <h2>Backend Status</h2>
          <div className="status">
            <span className="label">API:</span>
            <span className="value">{apiStatus}</span>
          </div>
          <div className="message">{apiMessage}</div>
        </div>

        <div className="info-card">
          <h3>🎮 Game Features</h3>
          <ul>
            <li>✈️ Gründe deine eigene Airline</li>
            <li>🛫 Kaufe Flugzeuge</li>
            <li>🗺️ Erstelle Routen weltweit</li>
            <li>📊 Manage deine Finanzen</li>
            <li>🏆 Level-System (1-30)</li>
            <li>💰 Startkapital: 50 Millionen USD</li>
          </ul>
        </div>

        <div className="buttons">
          <button className="btn-primary">Login</button>
          <button className="btn-secondary">Register</button>
        </div>

        <div className="footer">
          <p>Version 1.0.0 - MVP</p>
        </div>
      </div>
    </div>
  )
}

export default App
