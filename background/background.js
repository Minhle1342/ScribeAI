/**
 * background/background.js
 * Manifest V3 Service Worker.
 * Manages offscreen recording lifecycles, keep-alive heartbeat, tab audio streams,
 * and orchestrates IndexedDB aggregation and Gemini summarizations.
 */

importScripts('../services/db.js', '../services/geminiService.js');


let activeRecordingTabId = null;
let currentRecordingState = 'IDLE'; // IDLE | RECORDING | SUMMARIZING | COMPLETED | ERROR
let keepAliveIntervalId = null;

// Initialize state in local storage on startup
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    recordingState: 'IDLE',
    websocketUrl: 'ws://localhost:8080/stt',
    finalSummary: null
  });
  console.log('Gemini Meeting Recorder Service Worker Initialized.');
});

// Configure periodic alarms to prevent Service Worker sleep cycle during long recordings
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAliveAlarm') {
    console.log('[Heartbeat] Alarm received - refreshing Service Worker context.');
    // Simple ping to storage to reset background timer
    chrome.storage.local.get(['recordingState'], (data) => {
      console.log('[Heartbeat] State check:', data.recordingState);
    });
  }
});

/**
 * Enable alarm-based active keep-alive cycles.
 */
function startKeepAliveHeartbeat() {
  // Create an alarm to trigger every 1 minute
  chrome.alarms.create('keepAliveAlarm', { periodInMinutes: 1 });

  // Additional port-based connection heartbeat for deep reliability
  if (keepAliveIntervalId) clearInterval(keepAliveIntervalId);
  keepAliveIntervalId = setInterval(() => {
    console.log('[Heartbeat] Sending internal keep-alive pulse...');
    chrome.runtime.getPlatformInfo(() => {});
  }, 15000); // Pulse every 15s
}

/**
 * Terminate alarm-based keep-alive cycles to save browser resources.
 */
function stopKeepAliveHeartbeat() {
  chrome.alarms.clear('keepAliveAlarm');
  if (keepAliveIntervalId) {
    clearInterval(keepAliveIntervalId);
    keepAliveIntervalId = null;
  }
}

/**
 * Handle incoming messages from Content Script or Popup UI.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background received message:', message);

  // 1. Trigger Recording Start
  if (message.action === 'START_RECORDING_REQUEST') {
    const tabId = sender.tab ? sender.tab.id : null;
    if (!tabId) {
      sendResponse({ success: false, error: 'Recording must be triggered from a GMeet/Teams meeting tab.' });
      return;
    }

    activeRecordingTabId = tabId;
    chrome.storage.local.get(['websocketUrl'], async (storageData) => {
      const wsUrl = storageData.websocketUrl || 'ws://localhost:8080/stt';
      try {
        await startMeetingRecording(tabId, wsUrl);
        sendResponse({ success: true });
      } catch (err) {
        console.error('Failed to start recording workflow:', err);
        sendResponse({ success: false, error: err.message });
      }
    });
    return true; // Keep response channel open async
  }

  // 2. Trigger Recording Stop & Auto Summarize
  if (message.action === 'STOP_RECORDING_REQUEST') {
    const isFromContentScript = sender.tab != null;

    if (isFromContentScript && !activeRecordingTabId) {
      // GMeet mode: content script is stopping, no offscreen was started
      activeRecordingTabId = sender.tab.id;
    }

    // If source is content script (GMeet mode), skip offscreen teardown, just summarize
    if (isFromContentScript) {
      stopKeepAliveHeartbeat();
      updateGlobalState('SUMMARIZING');
      triggerSummarizationWorkflow()
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
    } else {
      // Normal WebSocket mode: stop offscreen then summarize
      stopMeetingRecording()
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
    }
    return true;
  }

  // 3. Trigger Manual Summary Request (from UI or restart)
  if (message.action === 'RUN_SUMMARIZATION_REQUEST') {
    triggerSummarizationWorkflow()
      .then((summary) => sendResponse({ success: true, summary }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // 4. Reset Session State
  if (message.action === 'RESET_MEETING_SESSION') {
    resetSession()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // 4b. Cancel Active Recording (Abrupt Stop & Clean database)
  if (message.action === 'CANCEL_RECORDING_REQUEST') {
    // 1. Close offscreen capture securely
    chrome.offscreen.closeDocument().catch(() => {});
    // 2. Stop keep alive
    stopKeepAliveHeartbeat();
    // 3. Clear transient storage records and IndexedDB chunks
    clearTranscriptDatabase().then(() => {
      chrome.storage.local.set({
        finalSummary: null,
        lastCompiledTranscript: null
      }, () => {
        updateGlobalState('IDLE');
        sendResponse({ success: true });
      });
    }).catch((err) => {
      console.error('Cancel recording clean failed:', err);
      updateGlobalState('IDLE');
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // 5. Pipe Live Transcripts from Offscreen to Content Script
  //    OR save captions from Content Script (GMeet mode) to IndexedDB
  if (message.action === 'TRANSCRIPT_APPENDED') {
    const isFromContentScript = sender.tab != null;

    if (isFromContentScript) {
      // GMeet caption mode: content script is the source
      // Save text directly to IndexedDB for later summarization
      if (!activeRecordingTabId) {
        activeRecordingTabId = sender.tab.id;
      }
      saveTranscriptChunk(message.text).then(() => {
        console.log('[GMeet Mode] Caption saved to IndexedDB:', message.text.substring(0, 60) + '...');
      }).catch((err) => {
        console.error('[GMeet Mode] Failed to save caption to IndexedDB:', err);
      });
    } else {
      // Normal WebSocket/Offscreen mode: relay to content script
      if (activeRecordingTabId) {
        chrome.tabs.sendMessage(activeRecordingTabId, {
          action: 'LIVE_TRANSCRIPT_UPDATE',
          text: message.text
        }).catch(() => {
          // Tab might have reloaded, ignore error
        });
      }
    }
  }

  // 5b. Pipe Live Volume Updates from Offscreen to Content Script
  if (message.action === 'VOLUME_UPDATE') {
    if (activeRecordingTabId) {
      chrome.tabs.sendMessage(activeRecordingTabId, {
        action: 'VOLUME_UPDATE',
        volume: message.volume
      }).catch(() => {
        // Tab might have reloaded, ignore error
      });
    }
  }

  // 6. Handle Recording Errors from Offscreen document
  if (message.action === 'RECORDING_ERROR') {
    console.error('Audio recorder context error:', message.error);
    updateGlobalState('ERROR', message.error);
    stopKeepAliveHeartbeat();
  }

  // 7. Synchronize States from Offscreen
  if (message.action === 'RECORDING_STATE_CHANGE') {
    updateGlobalState(message.state);
    if (message.state === 'IDLE') {
      stopKeepAliveHeartbeat();
    }
  }
});

/**
 * Launch Offscreen Document context if it does not already exist.
 */
async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (existingContexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capture and process meeting tab audio output streams'
  });
  console.log('Offscreen document spawned successfully.');
}

/**
 * Handle whole recording start flow:
 * Clear database -> Grab Tab Stream ID -> Setup Offscreen -> Send START message to Offscreen
 */
async function startMeetingRecording(tabId, wsUrl) {
  updateGlobalState('RECORDING');
  startKeepAliveHeartbeat();

  try {
    // 1. Clear database to start fresh session
    await clearTranscriptDatabase();

    // 2. Fetch the Deepgram API key from storage to pass to the offscreen document
    const storage = await chrome.storage.local.get(['deepgramApiKey']);
    const deepgramApiKey = storage.deepgramApiKey || '';

    // 3. Spawn offscreen window
    await ensureOffscreenDocument();

    // 4. Acquire Stream ID from the target tab
    // Must be invoked in Background SW context
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!id) {
          reject(new Error('Tab capture was denied. Verify extension permissions.'));
        } else {
          resolve(id);
        }
      });
    });

    // 5. Trigger Offscreen record start, passing the Deepgram Key safely
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'START_RECORDING',
      streamId: streamId,
      websocketUrl: wsUrl,
      deepgramApiKey: deepgramApiKey
    });

    if (!response || !response.success) {
      throw new Error(response?.error || 'Failed to initialize recording capture in offscreen.');
    }

    console.log('Tab audio recording and streaming established.');

  } catch (error) {
    updateGlobalState('ERROR', error.message);
    stopKeepAliveHeartbeat();
    throw error;
  }
}

/**
 * Stop active recording capture:
 * Tell offscreen document to STOP -> Close offscreen document -> Trigger Summarization
 */
async function stopMeetingRecording() {
  stopKeepAliveHeartbeat();
  updateGlobalState('SUMMARIZING');

  try {
    // 1. Stop recording in Offscreen
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'STOP_RECORDING'
    }).catch(() => {
      // Offscreen might have already closed or been unloaded
    });

    // 2. Safely close offscreen document
    await chrome.offscreen.closeDocument().catch(() => {});
    console.log('Offscreen document closed.');

    // 3. Automatically execute summarization logic
    await triggerSummarizationWorkflow();

  } catch (error) {
    updateGlobalState('ERROR', error.message);
    throw error;
  }
}

/**
 * Main AI Orchestration:
 * Compile full transcript from IndexedDB -> Send to Gemini Rolling Summary -> Save Final Result
 */
async function triggerSummarizationWorkflow() {
  updateGlobalState('SUMMARIZING');

  try {
    // 1. Retrieve full compiled transcript
    const fullTranscript = await getCompiledTranscript();
    console.log('Loaded compiled transcript from IndexedDB. Size:', fullTranscript.length);

    if (!fullTranscript || fullTranscript.trim() === '') {
      throw new Error('No meeting transcript found. Record audio or verify WebSocket connection.');
    }

    // 2. Direct fetch and chunking call to Gemini
    const summaryResult = await generateMeetingSummary(fullTranscript);

    // 3. Save final summary data to local storage
    await new Promise((resolve) => {
      chrome.storage.local.set({
        finalSummary: summaryResult,
        lastCompiledTranscript: fullTranscript
      }, resolve);
    });

    updateGlobalState('COMPLETED');
    console.log('Summarization complete! Saved JSON structure to local storage.');

    // Relay summary update message to the content script UIs
    if (activeRecordingTabId) {
      chrome.tabs.sendMessage(activeRecordingTabId, {
        action: 'SUMMARIZATION_COMPLETE',
        summary: summaryResult
      }).catch(() => {});
    }

    return summaryResult;

  } catch (error) {
    console.error('Summarization pipeline crash:', error);
    updateGlobalState('ERROR', error.message);
    
    // Relay error state to page panels
    if (activeRecordingTabId) {
      chrome.tabs.sendMessage(activeRecordingTabId, {
        action: 'SUMMARIZATION_ERROR',
        error: error.message
      }).catch(() => {});
    }
    throw error;
  }
}

/**
 * Reset meeting state and storage records.
 */
async function resetSession() {
  stopKeepAliveHeartbeat();
  await clearTranscriptDatabase();
  await new Promise((resolve) => {
    chrome.storage.local.set({
      finalSummary: null,
      lastCompiledTranscript: null
    }, () => {
      updateGlobalState('IDLE');
      resolve();
    });
  });
}

/**
 * Helper to update global state and broadcast modifications.
 */
function updateGlobalState(state, errorMessage = null) {
  currentRecordingState = state;
  chrome.storage.local.set({
    recordingState: state,
    recordingError: errorMessage
  });

  console.log(`Global state transitioned to: ${state}`);

  // Broadcast state changes globally to active tabs
  if (activeRecordingTabId) {
    chrome.tabs.sendMessage(activeRecordingTabId, {
      action: 'STATE_CHANGED',
      state: state,
      error: errorMessage
    }).catch(() => {});
  }
}
