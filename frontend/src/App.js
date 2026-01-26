// src/App.js - Simple React frontend for managing SDR boards
// Uses Bootstrap for UI, Axios for REST API, Socket.io for real-time updates.
// Displays SDR boards as cards with states and controls for gain, gen_mode, freq.
// Includes init button and custom command input.
// Run with create-react-app or similar setup.
// Dependencies: Install with `npm install react-bootstrap bootstrap axios socket.io-client`
// Import Bootstrap CSS in index.js or use CDN in index.html.
// Updates: Gain mode always manual (display only), added gen modes and their checkboxes (WN, FSK, etc.), freq in MHz, TX state display, removed custom command, 4-column layout.
// 1. if Gain Mode: slow_attack set manual. remove from ui - removed display.
// only 1 mode at one time. disable all others when enable some - use radio buttons with 'none' option.
// Display current sampling_frequency, add input field, hide input if NTSC.
// Sampling Frequency input/display now in MHz (consistent with freq).
// Dynamically show/hide sampling_freq based on local mode selection (before apply).
// Added Reconnect button for each SDR.
// Added Restart USB button (global, cycles all ports on hub 1-1).
// Buttons become inactive (disabled) during background processes (init, reconnect, apply, usb restart).
// Updated: Restart USB is now per SDR, using new /api/sdrs/:id/restart_usb endpoint. Added per-SDR loading state for USB restart.

import React, { useState, useEffect } from 'react';
import { Container, Row, Col, Card, Button, Form, Alert } from 'react-bootstrap';
import axios from 'axios';
import io from 'socket.io-client';

const API_BASE_URL = '/api'; // Adjust if needed
const SOCKET_URL = ''; // Adjust if needed
// const API_BASE_URL = 'http://localhost:3000/api'; // Adjust if needed
// const SOCKET_URL = 'http://localhost:3000'; // Adjust if needed

function App() {
  const [sdrs, setSdrs] = useState([]);
  const [localSettings, setLocalSettings] = useState({}); // Local pending changes per SDR id
  const [isLoading, setIsLoading] = useState({}); // Per SDR loading state for init/reconnect/apply/usb_restart
  const [socket, setSocket] = useState(null);
  const [error, setError] = useState(null);

  // Fetch SDR list on mount
  useEffect(() => {
    fetchSdrs();
  }, []);

  // Setup Socket.io (run only once on mount)
  useEffect(() => {
    const newSocket = io(SOCKET_URL);
    setSocket(newSocket);

    newSocket.on('initialStates', (states) => {
      updateSdrsWithStates(states);
    });

    newSocket.on('sdrUpdate', ({ id, state }) => {
      updateSdrState(id, state);
    });

    return () => newSocket.disconnect();
  }, []); // Empty dependency array: Runs only once

  // Reset local settings when sdrs update (store freq/sampling_freq in MHz)
  useEffect(() => {
    const newLocal = {};
    const newLoading = {};
    sdrs.forEach(sdr => {
      newLocal[sdr.id] = {
        gain: sdr.state?.gain ?? 0,
        freq: sdr.state?.freq ? sdr.state.freq / 1000000 : null,
        sampling_freq: sdr.state?.sampling_freq ? sdr.state.sampling_freq / 1000000 : null,
        mode: getCurrentMode(sdr.state?.modes)
      };
      newLoading[sdr.id] = { init: false, reconnect: false, apply: false, usb_restart: false };
    });
    setLocalSettings(newLocal);
    setIsLoading(newLoading);
  }, [sdrs]);

  const fetchSdrs = async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/sdrs`);
      setSdrs(response.data);
      setError(null);
    } catch (err) {
      setError('Failed to fetch SDRs: ' + err.message);
    }
  };

  const updateSdrsWithStates = (states) => {
    setSdrs(prevSdrs =>
        prevSdrs.map(sdr => ({
          ...sdr,
          state: states[sdr.id] || sdr.state
        }))
    );
  };

  const updateSdrState = (id, newState) => {
    setSdrs(prevSdrs =>
        prevSdrs.map(sdr =>
            sdr.id === id ? { ...sdr, state: newState } : sdr
        )
    );
  };

  const setSdrLoading = (id, type, loading) => {
    setIsLoading(prev => ({
      ...prev,
      [id]: { ...prev[id], [type]: loading }
    }));
  };

  const isAnyLoading = (id) => {
    return Object.values(isLoading[id] || {}).some(v => v);
  };

  const handleInit = async (id) => {
    setSdrLoading(id, 'init', true);
    try {
      await axios.post(`${API_BASE_URL}/sdrs/${id}/init`);
      setError(null);
    } catch (err) {
      setError('Init failed: ' + err.message);
    } finally {
      setSdrLoading(id, 'init', false);
    }
  };

  const handleReconnect = async (id) => {
    setSdrLoading(id, 'reconnect', true);
    try {
      await axios.post(`${API_BASE_URL}/sdrs/${id}/reconnect`);
      setError(null);
    } catch (err) {
      setError('Reconnect failed: ' + err.message);
    } finally {
      setSdrLoading(id, 'reconnect', false);
    }
  };
  const handleRestartAllUsb = async () => {
    try {
      await axios.post(`${API_BASE_URL}/restart_usb`);
      setError(null);
      alert('USB power cycle initiated for all SDRs. Reconnecting...');
    } catch (err) {
      setError('USB restart failed: ' + err.message);
    }
  };

  const handleRestartUsb = async (id) => {
    setSdrLoading(id, 'usb_restart', true);
    try {
      await axios.post(`${API_BASE_URL}/sdrs/${id}/restart_usb`);
      setError(null);
      alert(`USB power cycle initiated for SDR ${id}. Reconnecting...`);
    } catch (err) {
      setError('USB restart failed: ' + err.message);
    } finally {
      setSdrLoading(id, 'usb_restart', false);
    }
  };

  const getCurrentMode = (modes) => {
    if (!modes) return 'none';
    const activeMode = Object.keys(modes).find(key => modes[key]);
    return activeMode || 'none';
  };

  const updateLocalSetting = (id, key, value) => {
    setLocalSettings(prev => ({
      ...prev,
      [id]: { ...prev[id], [key]: value }
    }));
  };

  const hasChanges = (id) => {
    const state = sdrs.find(sdr => sdr.id === id)?.state;
    if (!state) return false;

    const local = localSettings[id];
    return (
        local.gain !== state.gain ||
        (local.freq !== null && local.freq * 1000000 !== state.freq) ||
        (local.sampling_freq !== null && local.sampling_freq * 1000000 !== state.sampling_freq) ||
        local.mode !== getCurrentMode(state.modes)
    );
  };

  const handleApply = async (id) => {
    setSdrLoading(id, 'apply', true);
    try {
      const local = localSettings[id];

      if (local.gain !== sdrs.find(sdr => sdr.id === id).state.gain) {
        await axios.post(`${API_BASE_URL}/sdrs/${id}/gain`, { value: local.gain });
      }

      if (local.freq !== null && local.freq * 1000000 !== sdrs.find(sdr => sdr.id === id).state.freq) {
        await axios.post(`${API_BASE_URL}/sdrs/${id}/freq`, { value: local.freq * 1000000 });
      }

      if (local.mode !== getCurrentMode(sdrs.find(sdr => sdr.id === id).state.modes)) {
        await axios.post(`${API_BASE_URL}/sdrs/${id}/set_mode`, { mode: local.mode });
      }

      if (local.mode !== 'ntsc' && local.sampling_freq !== null && local.sampling_freq * 1000000 !== sdrs.find(sdr => sdr.id === id).state.sampling_freq) {
        await axios.post(`${API_BASE_URL}/sdrs/${id}/sampling_freq`, { value: local.sampling_freq * 1000000 });
      }

      setError(null);
    } catch (err) {
      setError('Apply failed: ' + err.message);
    } finally {
      setSdrLoading(id, 'apply', false);
    }
  };

  return (
      <Container className="mt-4">
        {error && <Alert variant="danger">{error}</Alert>}
        <Button variant="danger" onClick={handleRestartAllUsb} className="mb-4">
          Restart All USB (Power Cycle SDRs)
        </Button>
        <Row>
          {sdrs.map(sdr => (
              <Col md={3} key={sdr.id} className="mb-4">
                <Card>
                  <Card.Header>{sdr.id.toUpperCase()}</Card.Header>
                  <Card.Body>
                    <p>Initialized: {sdr.state?.initialized ? 'Yes' : 'No'}</p>
                    <p>Connected: {sdr.state?.connected ? 'Yes' : 'No'}</p>
                    <p>Gain: {sdr.state?.gain}</p>
                    <p>Frequency: {sdr.state?.freq ? sdr.state.freq / 1000000 : 'N/A'} MHz</p>
                    <p>Sampling Frequency: {sdr.state?.sampling_freq ? sdr.state.sampling_freq / 1000000 : 'N/A'} MHz</p>
                    <p>Mode: {getCurrentMode(sdr.state?.modes).toUpperCase()}</p>
                    <p>TX On: {sdr.state?.tx_on ? 'Yes' : 'No'}</p>

                    {!sdr.state?.initialized ? (
                        <Button variant="primary" onClick={() => handleInit(sdr.id)} className="mb-2" disabled={isAnyLoading(sdr.id)}>
                          {isLoading[sdr.id]?.init ? 'Initializing...' : 'Initialize'}
                        </Button>
                    ) : (
                        <>
                          <Button variant="secondary" onClick={() => handleReconnect(sdr.id)} className="mb-2 mr-2" disabled={isAnyLoading(sdr.id)}>
                            {isLoading[sdr.id]?.reconnect ? 'Reconnecting...' : 'Reconnect'}
                          </Button>
                          <Button variant="warning" onClick={() => handleRestartUsb(sdr.id)} className="mb-2" disabled={isAnyLoading(sdr.id)}>
                            {isLoading[sdr.id]?.usb_restart ? 'Restarting USB...' : 'Restart USB'}
                          </Button>
                        </>
                    )}

                    <Form.Group className="mb-2">
                      <Form.Label>Set Gain (default 0)</Form.Label>
                      <Form.Control
                          type="number"
                          value={localSettings[sdr.id]?.gain ?? 0}
                          onChange={(e) => updateLocalSetting(sdr.id, 'gain', parseInt(e.target.value))}
                          disabled={isAnyLoading(sdr.id) || !sdr.state?.initialized}
                      />
                    </Form.Group>

                    <Form.Group className="mb-2">
                      <Form.Label>Set Frequency (MHz)</Form.Label>
                      <Form.Control
                          type="number"
                          value={localSettings[sdr.id]?.freq ?? ''}
                          onChange={(e) => updateLocalSetting(sdr.id, 'freq', parseFloat(e.target.value))}
                          disabled={isAnyLoading(sdr.id) || !sdr.state?.initialized}
                      />
                    </Form.Group>

                    {localSettings[sdr.id]?.mode !== 'ntsc' && (
                        <Form.Group className="mb-2">
                          <Form.Label>Set Sampling Frequency (MHz)</Form.Label>
                          <Form.Control
                              type="number"
                              value={localSettings[sdr.id]?.sampling_freq ?? ''}
                              onChange={(e) => updateLocalSetting(sdr.id, 'sampling_freq', parseFloat(e.target.value))}
                              disabled={isAnyLoading(sdr.id) || !sdr.state?.initialized}
                          />
                        </Form.Group>
                    )}

                    <Form.Group className="mb-2">
                      <Form.Label>Gen Modes (only one at a time)</Form.Label>
                      <Form.Check
                          type="radio"
                          label="None"
                          checked={localSettings[sdr.id]?.mode === 'none'}
                          onChange={() => updateLocalSetting(sdr.id, 'mode', 'none')}
                          disabled={isAnyLoading(sdr.id) || !sdr.state?.initialized}
                      />
                      <Form.Check
                          type="radio"
                          label="White Noise"
                          checked={localSettings[sdr.id]?.mode === 'wn'}
                          onChange={() => updateLocalSetting(sdr.id, 'mode', 'wn')}
                          disabled={isAnyLoading(sdr.id) || !sdr.state?.initialized}
                      />
                      <Form.Check
                          type="radio"
                          label="FSK"
                          checked={localSettings[sdr.id]?.mode === 'fsk'}
                          onChange={() => updateLocalSetting(sdr.id, 'mode', 'fsk')}
                          disabled={isAnyLoading(sdr.id) || !sdr.state?.initialized}
                      />
                      <Form.Check
                          type="radio"
                          label="BPSK"
                          checked={localSettings[sdr.id]?.mode === 'bpsk'}
                          onChange={() => updateLocalSetting(sdr.id, 'mode', 'bpsk')}
                          disabled={isAnyLoading(sdr.id) || !sdr.state?.initialized}
                      />
                      <Form.Check
                          type="radio"
                          label="QPSK"
                          checked={localSettings[sdr.id]?.mode === 'qpsk'}
                          onChange={() => updateLocalSetting(sdr.id, 'mode', 'qpsk')}
                          disabled={isAnyLoading(sdr.id) || !sdr.state?.initialized}
                      />
                      <Form.Check
                          type="radio"
                          label="NTSC"
                          checked={localSettings[sdr.id]?.mode === 'ntsc'}
                          onChange={() => updateLocalSetting(sdr.id, 'mode', 'ntsc')}
                          disabled={isAnyLoading(sdr.id) || !sdr.state?.initialized}
                      />
                    </Form.Group>

                    {hasChanges(sdr.id) && (
                        <Button variant="success" onClick={() => handleApply(sdr.id)} className="mb-2" disabled={isAnyLoading(sdr.id) || !sdr.state?.initialized}>
                          {isLoading[sdr.id]?.apply ? 'Applying...' : 'Apply Changes'}
                        </Button>
                    )}
                  </Card.Body>
                </Card>
              </Col>
          ))}
        </Row>
      </Container>
  );
}

export default App;