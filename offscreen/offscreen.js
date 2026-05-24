/**
 * offscreen/offscreen.js
 * Runs inside the persistent offscreen document DOM window context.
 * Captures tab audio streams, routes audio to speakers (no mute), streams binary chunks
 * over a WebSocket to an external STT server, and stores returns in IndexedDB.
 */

let mediaRecorder = null;
let audioStream = null;
let micStream = null; // Independent microphone stream
let audioContext = null;
let webSocket = null;
let websocketUrl = 'ws://localhost:8080/stt'; // Default fallback, can be loaded from chrome.storage
let volumeInterval = null;

// Handle messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  console.log('Offscreen received command:', message);

  if (message.action === 'START_RECORDING') {
    startCapture(message.streamId, message.websocketUrl, message.deepgramApiKey)
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        console.error('Audio capture failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open for async response
  }

  if (message.action === 'STOP_RECORDING') {
    stopCapture();
    sendResponse({ success: true });
  }
});

/**
 * Capture tab audio, prevent muting, open WebSocket, and record.
 * @param {string} streamId The captured tab stream ID provided by the background worker.
 * @param {string} wsUrl Custom STT WebSocket endpoint.
 * @param {string} deepgramApiKey The Deepgram API key passed from background.js.
 */
async function startCapture(streamId, wsUrl, deepgramApiKey) {
  if (wsUrl) {
    websocketUrl = wsUrl;
  }

  updateUIStatus('Connecting and initializing capture...');

  try {
    // 1. Establish the WebSocket connection using the passed Deepgram Key
    const keyToUse = deepgramApiKey || '';

    let finalWsUrl = websocketUrl;
    if (keyToUse) {
      const connector = finalWsUrl.includes('?') ? '&' : '?';
      finalWsUrl = `${finalWsUrl}${connector}deepgramApiKey=${encodeURIComponent(keyToUse)}`;
    }

    await initWebSocket(finalWsUrl);

    // 2. Request active tab stream via the sent streamId
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    // Request local microphone stream with generic fallback safety
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true
        },
        video: false
      });
      console.log('[Offscreen Debug] Microphone stream captured successfully.');
    } catch (micError) {
      console.warn('[Offscreen Debug] Failed to capture microphone. Recording tab audio only:', micError);
    }

    // 3. RISK MITIGATION & DUAL-STREAM MIXING
    // Route tab audio back to speakers AND merge both streams into mixed destination
    audioContext = new AudioContext();
    const tabSource = audioContext.createMediaStreamSource(audioStream);
    
    // Connect tab audio back to speaker output so user hears the meeting
    tabSource.connect(audioContext.destination);

    // Create a mixed destination node
    const mixedDestination = audioContext.createMediaStreamDestination();
    
    // Create an AnalyserNode to measure real-time mixed volume level
    const analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;

    // Direct tab audio to mixed recorder destination and analyzer
    tabSource.connect(mixedDestination);
    tabSource.connect(analyserNode);

    // Connect mic source to mixed destination and analyzer
    if (micStream) {
      const micSource = audioContext.createMediaStreamSource(micStream);
      micSource.connect(mixedDestination);
      micSource.connect(analyserNode);
    }

    // 4. Initialize MediaRecorder with the MIXED stream
    // WebM Opus is the standard, highly efficient compressed audio codec
    const options = { mimeType: 'audio/webm;codecs=opus' };
    console.log('[Offscreen Debug] Initializing MediaRecorder with mixed stream options:', options);
    mediaRecorder = new MediaRecorder(mixedDestination.stream, options);

    mediaRecorder.ondataavailable = async (event) => {
      if (event.data && event.data.size > 0 && webSocket && webSocket.readyState === WebSocket.OPEN) {
        // Read file contents as ArrayBuffer
        const arrayBuffer = await event.data.arrayBuffer();
        console.log(`[Offscreen Debug] Sending binary audio chunk: ${arrayBuffer.byteLength} bytes to STT server.`);
        // Send raw binary audio slice over WebSocket
        webSocket.send(arrayBuffer);
      }
    };

    mediaRecorder.onstop = () => {
      console.log('[Offscreen Debug] MediaRecorder stopped capture successfully.');
      updateUIStatus('Stopped');
    };

    // Slice audio every 1000ms and stream chunks
    mediaRecorder.start(1000);
    updateUIStatus('Recording & Streaming');

    // Start volume meter polling
    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    volumeInterval = setInterval(() => {
      if (audioContext && audioContext.state !== 'closed') {
        analyserNode.getByteTimeDomainData(dataArray);
        let sumSquares = 0.0;
        for (let i = 0; i < bufferLength; i++) {
          const norm = (dataArray[i] - 128) / 128;
          sumSquares += norm * norm;
        }
        const rms = Math.sqrt(sumSquares / bufferLength);
        const volumeLevel = Math.min(100, Math.round(rms * 400));
        
        chrome.runtime.sendMessage({ 
          action: 'VOLUME_UPDATE', 
          volume: volumeLevel 
        });
      }
    }, 100);

    // Notify background script that streaming is active
    chrome.runtime.sendMessage({ action: 'RECORDING_STATE_CHANGE', state: 'RECORDING' });

  } catch (error) {
    updateUIStatus(`Error: ${error.message}`);
    cleanupStreams();
    chrome.runtime.sendMessage({ action: 'RECORDING_ERROR', error: error.message });
    throw error;
  }
}

/**
 * Establish connection with the external WebSocket STT Server.
 * @param {string} url
 * @returns {Promise<void>}
 */
function initWebSocket(url) {
  return new Promise((resolve, reject) => {
    try {
      console.log('Connecting to WebSocket STT Server:', url);
      webSocket = new WebSocket(url);
      webSocket.binaryType = 'arraybuffer';

      let connected = false;

      webSocket.onopen = () => {
        console.log('WebSocket Connection Opened.');
        connected = true;
        resolve();
      };

      webSocket.onmessage = async (event) => {
        try {
          console.log('[Offscreen Debug] Raw message received from STT WebSocket:', event.data);
          // Parse returned transcription text.
          // Server responds either with flat text or a JSON payload like {"text": "hello"}
          let transcribedText = '';
          if (typeof event.data === 'string') {
            try {
              const data = JSON.parse(event.data);
              transcribedText = data.text || data.transcript || event.data;
            } catch (_) {
              transcribedText = event.data;
            }
          }

          if (transcribedText.trim()) {
            console.log('[Offscreen Debug] Extracted Transcribed Text:', transcribedText);

            // RISK MITIGATION: Continuously append text chunks to browser IndexedDB
            // db.js is preloaded in offscreen.html and exposes window.meetingDB
            if (window.meetingDB && window.meetingDB.saveTranscriptChunk) {
              await window.meetingDB.saveTranscriptChunk(transcribedText);
            }

            // Notify background worker and injection UIs of the new text segment
            chrome.runtime.sendMessage({
              action: 'TRANSCRIPT_APPENDED',
              text: transcribedText
            });
          }
        } catch (dbError) {
          console.error('Error writing transcription chunk to storage:', dbError);
        }
      };

      webSocket.onerror = (error) => {
        console.error('[Offscreen Debug] WebSocket connection error event triggered:', error);
        if (!connected) {
          reject(new Error('Failed to connect to the external WebSocket STT server. Make sure it is running.'));
        } else {
          chrome.runtime.sendMessage({ action: 'RECORDING_ERROR', error: 'WebSocket connection lost.' });
        }
      };

      webSocket.onclose = (event) => {
        console.warn(`[Offscreen Debug] WebSocket connection closed by remote: Code ${event.code}, Reason: ${event.reason || 'None provided'}`);
        chrome.runtime.sendMessage({ action: 'RECORDING_STATE_CHANGE', state: 'IDLE' });
      };

    } catch (wsError) {
      reject(wsError);
    }
  });
}

/**
 * Stop capturing audio, close connection, clean up hardware resources.
 */
function stopCapture() {
  cleanupStreams();
  updateUIStatus('Stopped');
  chrome.runtime.sendMessage({ action: 'RECORDING_STATE_CHANGE', state: 'IDLE' });
}

/**
 * Cleanup audio tracks and close WebSocket connections safely.
 */
function cleanupStreams() {
  if (volumeInterval) {
    clearInterval(volumeInterval);
    volumeInterval = null;
  }

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  if (audioStream) {
    audioStream.getTracks().forEach((track) => track.stop());
    audioStream = null;
  }

  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  if (webSocket) {
    if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING) {
      webSocket.close();
    }
    webSocket = null;
  }

  mediaRecorder = null;
}

/**
 * Update visual offscreen DOM layout status logs for developer debugging.
 */
function updateUIStatus(status) {
  const statusEl = document.getElementById('status');
  const logEl = document.getElementById('log');
  if (statusEl) statusEl.textContent = status;
  if (logEl) logEl.textContent += `[${new Date().toLocaleTimeString()}] ${status}\n`;
}

// Bind domestic button click handler to request full meeting recording termination
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const cancelBtn = document.getElementById('cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'CANCEL_RECORDING_REQUEST' });
      });
    }
  });
}
