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
    chrome.storage.local.get(['recordingState'], async (data) => {
      if (data.recordingState === 'PAUSED') {
        // Resume!
        try {
          const currentMode = (await chrome.storage.local.get(['captureMode'])).captureMode || 'websocket';
          if (currentMode === 'websocket') {
            await chrome.runtime.sendMessage({
              target: 'offscreen',
              action: 'SET_PAUSE_STATE',
              isPaused: false
            });
          }
          updateGlobalState('RECORDING');
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
        return;
      }

      // Normal Start
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
    });
    return true; // Keep response channel open async
  }

  // 1b. Toggle Pause/Resume Recording
  if (message.action === 'TOGGLE_PAUSE_REQUEST') {
    chrome.storage.local.get(['recordingState'], async (storageData) => {
      const currentState = storageData.recordingState || 'IDLE';
      let nextState;
      let isPaused;
      if (currentState === 'RECORDING') {
        nextState = 'PAUSED';
        isPaused = true;
      } else if (currentState === 'PAUSED') {
        nextState = 'RECORDING';
        isPaused = false;
      } else {
        sendResponse({ success: false, error: 'Cannot toggle pause when not recording.' });
        return;
      }

      try {
        const currentMode = (await chrome.storage.local.get(['captureMode'])).captureMode || 'websocket';
        if (currentMode === 'websocket') {
          // Send to offscreen
          await chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'SET_PAUSE_STATE',
            isPaused: isPaused
          });
        }
        updateGlobalState(nextState);
        sendResponse({ success: true, state: nextState });
      } catch (err) {
        console.error('Failed to toggle pause:', err);
        sendResponse({ success: false, error: err.message });
      }
    });
    return true; // Keep response channel open async
  }

  // 1c. Trigger Recording Start for GMeet Mode
  if (message.action === 'START_GMEET_RECORDING') {
    activeRecordingTabId = sender.tab ? sender.tab.id : null;
    updateGlobalState('RECORDING');
    sendResponse({ success: true });
    return false;
  }

  // 2. Trigger Recording Stop & Auto Summarize
  if (message.action === 'STOP_RECORDING_REQUEST') {
    if (sender.tab && !activeRecordingTabId) {
      activeRecordingTabId = sender.tab.id;
    }

    chrome.storage.local.get(['captureMode'], async (storageMode) => {
      const currentMode = storageMode.captureMode || 'websocket';
      
      if (currentMode === 'gmeet' || currentMode === 'teams') {
        // GMeet/Teams mode: just summarize
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
    });
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
        lastCompiledTranscript: null,
        gmeetCaptions: {}
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

  // 4c. Handle Google Meet caption updates in-place
  if (message.action === 'UPDATE_GMEET_CAPTION') {
    if (currentRecordingState === 'PAUSED') return false;
    chrome.storage.local.get(['gmeetCaptions'], (data) => {
      const gmeetCaptions = data.gmeetCaptions || {};
      gmeetCaptions[message.blockKey] = {
        speaker: message.speaker,
        text: message.text,
        timestamp: gmeetCaptions[message.blockKey]?.timestamp || Date.now()
      };
      chrome.storage.local.set({ gmeetCaptions });
    });
    return false;
  }

  // 5. Pipe Live Transcripts from Offscreen to Content Script
  //    OR save captions from Content Script (GMeet mode) to IndexedDB
  if (message.action === 'TRANSCRIPT_APPENDED') {
    if (currentRecordingState === 'PAUSED') {
      sendResponse({ success: false, error: 'Recording is paused.' });
      return;
    }
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

  // 8. Capture Visible Tab for Magic Pencil
  if (message.action === 'CAPTURE_VISIBLE_TAB') {
    chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.error('Screen capture failed:', chrome.runtime.lastError.message);
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else if (!dataUrl) {
        sendResponse({ success: false, error: 'Failed to retrieve screenshot data.' });
      } else {
        sendResponse({ success: true, dataUrl: dataUrl });
      }
    });
    return true; // Keep response channel open async
  }

  // 9. Multimodal Vision Request for Magic Pencil
  if (message.action === 'GEMINI_VISION_REQUEST') {
    (async () => {
      try {
        const apiKey = await self.geminiService.getSavedApiKey();
        const model = await self.geminiService.getSavedModel();
        
        // Ensure a multimodal vision model is selected (defaulting to gemini-1.5-flash for compatibility)
        const visionModel = model.includes('flash') ? model : 'gemini-1.5-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${visionModel}:generateContent?key=${apiKey}`;
        
        const payload = {
          contents: [
            {
              parts: [
                {
                  text: message.prompt
                },
                {
                  inlineData: {
                    mimeType: "image/jpeg",
                    data: message.base64Image
                  }
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.2,
            topP: 0.95,
            maxOutputTokens: 1024
          }
        };

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          let errorMsg = `HTTP Error ${response.status}: ${response.statusText}`;
          try {
            const errorJson = await response.json();
            if (errorJson.error && errorJson.error.message) {
              errorMsg = errorJson.error.message;
            }
          } catch (_) {}
          throw new Error(errorMsg);
        }

        const result = await response.json();
        const rawText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawText) {
          throw new Error('Gemini returned an empty response.');
        }

        sendResponse({ success: true, text: rawText });
      } catch (err) {
        console.error('Gemini Vision request failed:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep response channel open async
  }

  // 10. Get SOP-based Suggestion for a Difficulty (Micro-MRP)
  if (message.action === 'GET_SOP_SUGGESTION') {
    (async () => {
      try {
        const apiKey = await self.geminiService.getSavedApiKey();
        const localData = await new Promise(resolve => chrome.storage.local.get(['sopRawText', 'uiLanguage'], resolve));
        const sopText = localData.sopRawText || '';
        const uiLanguage = localData.uiLanguage || 'vi';

        const result = await self.geminiService.solveDifficultyWithSop(
          apiKey,
          message.difficultyText,
          sopText,
          uiLanguage
        );
        sendResponse({ success: true, result });
      } catch (err) {
        console.error('SOP Suggestion execution failed:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep response channel open async
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
/**
 * Safe utility to retrieve Deepgram API key from session storage first,
 * falling back to local storage (ignoring if encrypted/locked).
 */
async function getSavedDeepgramApiKey() {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage) {
      resolve('');
      return;
    }
    if (chrome.storage.session) {
      chrome.storage.session.get(['deepgramApiKey'], (sessionResult) => {
        if (sessionResult && sessionResult.deepgramApiKey) {
          resolve(sessionResult.deepgramApiKey);
          return;
        }
        chrome.storage.local.get(['deepgramApiKey'], (localResult) => {
          const rawKey = localResult.deepgramApiKey;
          if (!rawKey) {
            resolve('');
            return;
          }
          if (typeof rawKey === 'object' && rawKey.ciphertext) {
            resolve(''); // Locked
            return;
          }
          resolve(rawKey);
        });
      });
    } else {
      chrome.storage.local.get(['deepgramApiKey'], (result) => {
        resolve(result.deepgramApiKey || '');
      });
    }
  });
}

/**
 * Programmatically verify if the extension has been granted microphone permission.
 */
async function verifyMicrophonePermission() {
  if (navigator.permissions && typeof navigator.permissions.query === 'function') {
    try {
      const permStatus = await navigator.permissions.query({ name: 'microphone' });
      if (permStatus.state === 'granted') {
        return true;
      }
    } catch (e) {
      console.warn('Background SW permissions query failed:', e);
    }
  }

  // Fallback: Check cached value in chrome.storage.local
  return new Promise((resolve) => {
    chrome.storage.local.get(['micPermissionGranted'], (data) => {
      resolve(!!data.micPermissionGranted);
    });
  });
}

async function startMeetingRecording(tabId, wsUrl) {
  // Verify microphone permission before initializing recording
  const isMicAllowed = await verifyMicrophonePermission();
  if (!isMicAllowed) {
    throw new Error('Microphone permission is not granted. Please open the Scribe AI extension popup and click "Grant Microphone Permission" to authorize microphone access.');
  }

  updateGlobalState('RECORDING');
  startKeepAliveHeartbeat();

  try {
    // 1. Clear database to start fresh session
    await clearTranscriptDatabase();

    // 2. Fetch the Deepgram API key from safe storage to pass to the offscreen document
    const deepgramApiKey = await getSavedDeepgramApiKey();

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
    let fullTranscript = '';
    const storageMode = await chrome.storage.local.get(['captureMode']);
    const currentMode = storageMode.captureMode || 'websocket';

    if (currentMode === 'gmeet' || currentMode === 'teams') {
      const storage = await chrome.storage.local.get(['gmeetCaptions']);
      const captions = storage.gmeetCaptions || {};
      const sortedBlocks = Object.values(captions).sort((a, b) => a.timestamp - b.timestamp);
      fullTranscript = sortedBlocks.map(b => `[${b.speaker}]: ${b.text}`).join('\n');
    } else {
      fullTranscript = await getCompiledTranscript();
    }

    console.log('Loaded compiled transcript. Size:', fullTranscript.length);

    if (!fullTranscript || fullTranscript.trim() === '') {
      throw new Error('No meeting transcript found. Record audio or verify WebSocket connection.');
    }

    // 2. Direct fetch and chunking call to Gemini
    const storageUiLang = await chrome.storage.local.get(['uiLanguage']);
    const uiLanguage = storageUiLang.uiLanguage || 'vi';
    const summaryResult = await generateMeetingSummary(fullTranscript, uiLanguage);

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
  try {
    if (typeof clearChatHistory === 'function') {
      await clearChatHistory();
    }
  } catch (err) {
    console.error('Failed to clear chat history:', err);
  }
  await new Promise((resolve) => {
    chrome.storage.local.set({
      finalSummary: null,
      lastCompiledTranscript: null,
      gmeetCaptions: {}
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
